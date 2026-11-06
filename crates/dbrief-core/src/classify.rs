//! Labels SQL as read, write or DDL before it is sent, so the app can block statements above a
//! connection's access level (the database also enforces RO on its own).
//!
//! Reads and writes are listed explicitly; every other statement, and anything that doesn't parse,
//! counts as DDL, the most restrictive label.

use serde::Serialize;
use sqlparser::ast::{Query, SetExpr, Statement};
use sqlparser::dialect::{Dialect, PostgreSqlDialect, SQLiteDialect};
use sqlparser::parser::Parser;

use crate::connections::{AccessLevel, Engine};

/// Ordered from least to most privileged, so the label of several statements is the highest one.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "kebab-case")]
pub enum StatementKind {
    Read,
    Write,
    Ddl,
}

impl StatementKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Read => "read",
            Self::Write => "write",
            Self::Ddl => "DDL",
        }
    }
}

/// Whether a connection at `level` may run a statement of `kind`.
pub fn allows(level: AccessLevel, kind: StatementKind) -> bool {
    match level {
        AccessLevel::Ro => kind == StatementKind::Read,
        AccessLevel::Rw => kind != StatementKind::Ddl,
        AccessLevel::Ddl => true,
    }
}

/// The label of `sql`, which may hold several statements (the highest label wins).
pub fn classify(sql: &str, engine: Engine) -> StatementKind {
    // sqlparser doesn't parse PostgreSQL's DO blocks; they run procedural code, so they are writes.
    if engine == Engine::Postgres && first_word(sql).eq_ignore_ascii_case("do") {
        return StatementKind::Write;
    }

    // sqlparser only takes literals in PRAGMA, while SQLite also takes names (`table_info(t)`,
    // `foreign_keys = ON`). PRAGMA name = value changes a setting; the other forms read.
    if engine == Engine::Sqlite && first_word(sql).eq_ignore_ascii_case("pragma") {
        return if sql.contains('=') {
            StatementKind::Write
        } else {
            StatementKind::Read
        };
    }

    let dialect: &dyn Dialect = match engine {
        Engine::Postgres => &PostgreSqlDialect {},
        Engine::Sqlite => &SQLiteDialect {},
    };

    match Parser::parse_sql(dialect, sql) {
        Ok(statements) => statements
            .iter()
            .map(statement_kind)
            .max()
            .unwrap_or(StatementKind::Read),
        Err(_) => StatementKind::Ddl,
    }
}

/// The first keyword, skipping whitespace and comments.
fn first_word(sql: &str) -> &str {
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

    let end = rest
        .find(|c: char| !c.is_ascii_alphanumeric() && c != '_')
        .unwrap_or(rest.len());
    &rest[..end]
}

fn statement_kind(statement: &Statement) -> StatementKind {
    use StatementKind::{Ddl, Read, Write};

    match statement {
        Statement::Query(query) => query_kind(query),

        Statement::Explain {
            analyze,
            statement,
            options,
            ..
        } => {
            let analyze_option = options.iter().flatten().any(|o| {
                o.name.value.eq_ignore_ascii_case("analyze")
                    && o.arg
                        .as_ref()
                        .is_none_or(|a| !a.to_string().eq_ignore_ascii_case("false"))
            });
            // EXPLAIN ANALYZE runs the statement; plain EXPLAIN only plans it.
            if *analyze || analyze_option {
                statement_kind(statement)
            } else {
                Read
            }
        }

        Statement::ExplainTable { .. }
        | Statement::ShowFunctions { .. }
        | Statement::ShowVariable { .. }
        | Statement::ShowStatus { .. }
        | Statement::ShowVariables { .. }
        | Statement::ShowCreate { .. }
        | Statement::ShowColumns { .. }
        | Statement::ShowCatalogs { .. }
        | Statement::ShowDatabases { .. }
        | Statement::ShowProcessList { .. }
        | Statement::ShowSchemas { .. }
        | Statement::ShowCharset(_)
        | Statement::ShowObjects(_)
        | Statement::ShowTables { .. }
        | Statement::ShowViews { .. }
        | Statement::ShowCollation { .. }
        | Statement::Set(_)
        | Statement::Reset(_)
        | Statement::Discard { .. }
        | Statement::Use(_)
        | Statement::StartTransaction { .. }
        | Statement::Commit { .. }
        | Statement::Rollback { .. }
        | Statement::Savepoint { .. }
        | Statement::ReleaseSavepoint { .. }
        | Statement::Fetch { .. }
        | Statement::Close { .. }
        | Statement::Deallocate { .. }
        | Statement::LISTEN { .. }
        | Statement::UNLISTEN { .. } => Read,

        // A cursor declaration is as privileged as its query.
        Statement::Declare { stmts } => stmts
            .iter()
            .filter_map(|d| d.for_query.as_deref())
            .map(query_kind)
            .max()
            .unwrap_or(Read),

        Statement::Copy { to, .. } => {
            if *to {
                Read
            } else {
                Write
            }
        }

        Statement::Insert(_)
        | Statement::Update(_)
        | Statement::Delete(_)
        | Statement::Merge(_)
        | Statement::Call(_)
        | Statement::Execute { .. }
        | Statement::Prepare { .. }
        | Statement::Vacuum(_)
        | Statement::Analyze(_)
        | Statement::Lock(_)
        | Statement::NOTIFY { .. } => Write,

        _ => Ddl,
    }
}

/// A query reads unless it has a data-modifying CTE, locks rows (`FOR UPDATE`), or creates a table
/// (`SELECT … INTO`).
fn query_kind(query: &Query) -> StatementKind {
    let locks = if query.locks.is_empty() {
        StatementKind::Read
    } else {
        StatementKind::Write
    };
    let ctes = query
        .with
        .iter()
        .flat_map(|w| &w.cte_tables)
        .map(|cte| query_kind(&cte.query))
        .max()
        .unwrap_or(StatementKind::Read);

    locks.max(ctes).max(set_expr_kind(&query.body))
}

fn set_expr_kind(body: &SetExpr) -> StatementKind {
    match body {
        SetExpr::Select(select) if select.into.is_some() => StatementKind::Ddl,
        SetExpr::Select(_) | SetExpr::Values(_) | SetExpr::Table(_) => StatementKind::Read,
        SetExpr::Query(query) => query_kind(query),
        SetExpr::SetOperation { left, right, .. } => set_expr_kind(left).max(set_expr_kind(right)),
        SetExpr::Insert(s) | SetExpr::Update(s) | SetExpr::Delete(s) | SetExpr::Merge(s) => {
            statement_kind(s)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::StatementKind::{Ddl, Read, Write};
    use super::*;

    #[test]
    fn labels_postgres_statements() {
        let cases = [
            ("SELECT * FROM t", Read),
            ("with x as (select 1) select * from x", Read),
            ("select 1 union select 2", Read),
            ("VALUES (1), (2)", Read),
            ("-- note\nSELECT 1", Read),
            ("SELECT * FROM t FOR UPDATE", Write),
            ("SELECT * INTO new_t FROM t", Ddl),
            ("INSERT INTO t VALUES (1)", Write),
            ("UPDATE t SET a = 1", Write),
            ("DELETE FROM t", Write),
            (
                "MERGE INTO t USING s ON t.id = s.id WHEN MATCHED THEN DELETE",
                Write,
            ),
            (
                "WITH gone AS (DELETE FROM t RETURNING *) SELECT * FROM gone",
                Write,
            ),
            ("CREATE TABLE t (a int)", Ddl),
            ("ALTER TABLE t ADD COLUMN b int", Ddl),
            ("DROP TABLE t", Ddl),
            ("TRUNCATE t", Ddl),
            ("GRANT SELECT ON t TO bob", Ddl),
            ("REVOKE SELECT ON t FROM bob", Ddl),
            ("CREATE INDEX i ON t (a)", Ddl),
            ("EXPLAIN SELECT 1", Read),
            ("EXPLAIN DELETE FROM t", Read),
            ("EXPLAIN ANALYZE DELETE FROM t", Write),
            ("EXPLAIN (ANALYZE, BUFFERS) UPDATE t SET a = 1", Write),
            ("EXPLAIN (ANALYZE false) UPDATE t SET a = 1", Read),
            ("BEGIN", Read),
            ("COMMIT", Read),
            ("ROLLBACK", Read),
            ("SAVEPOINT s", Read),
            ("SET search_path TO app", Read),
            ("SHOW TimeZone", Read),
            ("COPY t TO STDOUT", Read),
            ("COPY t FROM STDIN", Write),
            ("CALL do_things()", Write),
            ("DO $$ BEGIN PERFORM 1; END $$", Write),
            ("VACUUM t", Write),
            ("this is not sql", Ddl),
            ("SELECT 1; DELETE FROM t", Write),
            ("", Read),
        ];

        for (sql, expected) in cases {
            assert_eq!(classify(sql, Engine::Postgres), expected, "{sql}");
        }
    }

    #[test]
    fn labels_sqlite_statements() {
        let cases = [
            ("SELECT * FROM t", Read),
            ("PRAGMA table_info(t)", Read),
            ("PRAGMA foreign_keys = ON", Write),
            ("pragma user_version", Read),
            ("INSERT OR REPLACE INTO t VALUES (1)", Write),
            ("CREATE TABLE t (a INTEGER)", Ddl),
            ("DROP TABLE t", Ddl),
            ("VACUUM", Write),
        ];

        for (sql, expected) in cases {
            assert_eq!(classify(sql, Engine::Sqlite), expected, "{sql}");
        }
    }

    #[test]
    fn access_levels_allow_up_to_their_kind() {
        assert!(allows(AccessLevel::Ro, Read));
        assert!(!allows(AccessLevel::Ro, Write));
        assert!(allows(AccessLevel::Rw, Write));
        assert!(!allows(AccessLevel::Rw, Ddl));
        assert!(allows(AccessLevel::Ddl, Ddl));
    }

    #[test]
    fn finds_the_first_word_past_comments() {
        assert_eq!(first_word("  -- a\n /* b */ DO $$ $$"), "DO");
        assert_eq!(first_word("select"), "select");
    }
}
