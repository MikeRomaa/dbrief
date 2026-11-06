//! Transaction state for a session: auto-commit or manual mode, the open transaction's statements
//! (for confirm before commit), and Commit / Roll back.
//!
//! In manual mode the session sends `BEGIN` before the first write or DDL statement; reads alone
//! never open a transaction. `BEGIN`, `COMMIT`, `ROLLBACK` and `END` typed by the user update the
//! same state.

use serde::{Deserialize, Serialize};

use super::{Session, SessionError};
use crate::classify::StatementKind;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "kebab-case")]
pub enum TransactionMode {
    Auto,
    Manual,
}

/// A write or DDL statement in the open transaction. `rows_affected` is unknown for a statement whose
/// returned rows weren't all read.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct TransactionStatement {
    pub sql: String,
    pub kind: StatementKind,
    #[cfg_attr(feature = "specta", specta(type = Option<f64>))]
    pub rows_affected: Option<u64>,
}

/// What a statement does to the transaction, judged from its first words.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Control {
    Begin,
    End,
}

/// The first `n` words, lowercased, skipping leading whitespace and comments.
fn leading_words(sql: &str, n: usize) -> Vec<String> {
    let mut rest = sql.trim_start();
    loop {
        if let Some(line) = rest.strip_prefix("--") {
            rest = line.split_once('\n').map_or("", |(_, r)| r).trim_start();
        } else if let Some(block) = rest.strip_prefix("/*") {
            rest = block.split_once("*/").map_or("", |(_, r)| r).trim_start();
        } else {
            break;
        }
    }

    rest.split(|c: char| c.is_whitespace() || c == ';')
        .filter(|w| !w.is_empty())
        .take(n)
        .map(str::to_ascii_lowercase)
        .collect()
}

pub(super) fn control(sql: &str) -> Option<Control> {
    let words = leading_words(sql, 2);
    match words.first().map(String::as_str) {
        Some("begin") => Some(Control::Begin),
        Some("start") if words.get(1).is_some_and(|w| w == "transaction") => Some(Control::Begin),
        Some("commit" | "end" | "abort") => Some(Control::End),
        // ROLLBACK TO SAVEPOINT keeps the transaction open.
        Some("rollback") if words.get(1).is_none_or(|w| w != "to") => Some(Control::End),
        _ => None,
    }
}

/// Statements PostgreSQL refuses inside a transaction block, so manual mode never wraps them.
fn runs_outside_transaction(sql: &str) -> bool {
    let words = leading_words(sql, 2);
    let first = words.first().map(String::as_str);
    let second = words.get(1).map(String::as_str);
    matches!(first, Some("vacuum"))
        || matches!(
            (first, second),
            (Some("create" | "drop"), Some("database" | "tablespace"))
        )
        || matches!((first, second), (Some("alter"), Some("system")))
        || sql.to_ascii_lowercase().contains(" concurrently")
}

pub(super) fn needs_transaction(sql: &str, kind: StatementKind) -> bool {
    kind != StatementKind::Read && control(sql).is_none() && !runs_outside_transaction(sql)
}

impl Session {
    pub fn transaction_mode(&self) -> TransactionMode {
        self.mode
    }

    /// Switches between auto-commit and manual. Not while a transaction is open: commit or roll back
    /// first.
    pub fn set_transaction_mode(&mut self, mode: TransactionMode) -> Result<(), SessionError> {
        if self.in_transaction && mode != self.mode {
            return Err(SessionError::Invalid(
                "commit or roll back the open transaction before changing the mode".into(),
            ));
        }
        self.mode = mode;
        Ok(())
    }

    /// The write and DDL statements in the open transaction, for confirm before commit.
    pub fn transaction_statements(&self) -> &[TransactionStatement] {
        &self.transaction
    }

    pub async fn commit(&mut self) -> Result<(), SessionError> {
        self.end_transaction("COMMIT").await
    }

    pub async fn rollback(&mut self) -> Result<(), SessionError> {
        self.end_transaction("ROLLBACK").await
    }

    /// Ends the transaction either way: a failed COMMIT has rolled it back.
    async fn end_transaction(&mut self, sql: &str) -> Result<(), SessionError> {
        if !self.in_transaction {
            return Ok(());
        }

        let result = self.execute(sql).await;
        self.in_transaction = false;
        self.transaction.clear();
        result
    }

    /// Sends `BEGIN` when manual mode needs a transaction for this statement.
    pub(super) async fn begin_if_needed(
        &mut self,
        sql: &str,
        kind: StatementKind,
    ) -> Result<(), SessionError> {
        if self.mode == TransactionMode::Manual
            && !self.in_transaction
            && needs_transaction(sql, kind)
        {
            self.execute("BEGIN").await?;
            self.in_transaction = true;
            self.transaction.clear();
        }
        Ok(())
    }

    /// Updates the transaction state after a statement ran.
    pub(super) fn track(&mut self, sql: &str, kind: StatementKind, rows_affected: Option<u64>) {
        match control(sql) {
            Some(Control::Begin) => {
                self.in_transaction = true;
                self.transaction.clear();
            }
            Some(Control::End) => {
                self.in_transaction = false;
                self.transaction.clear();
            }
            None if self.in_transaction && kind != StatementKind::Read => {
                self.transaction.push(TransactionStatement {
                    sql: sql.trim().to_owned(),
                    kind,
                    rows_affected,
                });
            }
            None => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognizes_transaction_control() {
        assert_eq!(control("BEGIN"), Some(Control::Begin));
        assert_eq!(control("-- start\nbegin immediate;"), Some(Control::Begin));
        assert_eq!(
            control("START TRANSACTION ISOLATION LEVEL SERIALIZABLE"),
            Some(Control::Begin)
        );
        assert_eq!(control("commit"), Some(Control::End));
        assert_eq!(control("END"), Some(Control::End));
        assert_eq!(control("ROLLBACK"), Some(Control::End));
        assert_eq!(control("rollback to savepoint a"), None);
        assert_eq!(control("start_date"), None);
        assert_eq!(control("SELECT 1"), None);
    }

    #[test]
    fn decides_what_manual_mode_wraps() {
        assert!(needs_transaction(
            "UPDATE t SET a = 1",
            StatementKind::Write
        ));
        assert!(needs_transaction(
            "CREATE TABLE t (a int)",
            StatementKind::Ddl
        ));
        assert!(!needs_transaction("SELECT 1", StatementKind::Read));
        assert!(!needs_transaction("VACUUM t", StatementKind::Write));
        assert!(!needs_transaction("CREATE DATABASE x", StatementKind::Ddl));
        assert!(!needs_transaction(
            "CREATE INDEX CONCURRENTLY i ON t (a)",
            StatementKind::Ddl
        ));
        assert!(!needs_transaction("COMMIT", StatementKind::Read));
    }
}
