//! Applying a batch of staged grid changes (see `edit`).
//!
//! In auto-commit mode the batch is its own transaction: `BEGIN`, the statements, `COMMIT`, and a
//! rollback of everything when one fails. With confirm before commit the transaction stays open
//! after the statements ran, for the user to commit or roll back.
//!
//! In manual mode the batch runs inside the tab's transaction (opened if needed) under a savepoint,
//! so a failure undoes only this batch and recovers PostgreSQL's aborted transaction. The transaction
//! stays open for Commit / Roll back.
//!
//! Every statement must change exactly one row; anything else means the row changed since it was
//! loaded, and fails the batch.

use serde::Serialize;

use super::{RunError, Session, SessionError, TransactionMode, TransactionStatement};
use crate::edit::{self, EditBatch, EditStatement, PageSource};
use crate::grid::ImageKind;

const SAVEPOINT: &str = "dbrief_grid";

/// Largest file that can be uploaded into a cell.
pub const UPLOAD_LIMIT: u64 = 64 * 1024 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "kebab-case")]
pub enum ApplyState {
    /// Auto-commit: the batch is committed.
    Committed,
    /// Manual mode: the batch ran inside the open transaction.
    Applied,
    /// Auto-commit with confirm before commit: the batch ran and waits for Commit or Roll back.
    AwaitingConfirm,
}

/// The statements of a batch that ran, with their rows affected.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct ApplyOutcome {
    pub state: ApplyState,
    pub statements: Vec<TransactionStatement>,
    pub in_transaction: bool,
}

/// A batch that failed and was undone. `change` indexes the batch's changes when one change caused
/// it, and `sql` is that change's statement.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct EditFailure {
    pub change: Option<u32>,
    pub sql: Option<String>,
    pub error: RunError,
}

impl EditFailure {
    fn general(e: SessionError) -> Self {
        Self {
            change: None,
            sql: None,
            error: e.into(),
        }
    }
}

impl From<SessionError> for EditFailure {
    fn from(e: SessionError) -> Self {
        Self::general(e)
    }
}

/// A file read into the session for a staged binary value.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct StagedFile {
    pub token: String,
    pub size: u32,
    pub image: Option<ImageKind>,
}

impl Session {
    /// The statements a batch would run, built from the loaded page.
    pub fn edit_statements(&self, batch: &EditBatch) -> Result<Vec<EditStatement>, SessionError> {
        let source = PageSource {
            page: self.page()?,
            rowids: &self.page_rowids,
            uploads: &self.uploads,
        };
        edit::statements(self.info.engine, batch, &source)
    }

    /// Reads a file for a staged binary value and returns its token.
    pub fn stage_file(&mut self, path: &std::path::Path) -> Result<StagedFile, SessionError> {
        let size = std::fs::metadata(path)
            .map_err(|e| SessionError::Invalid(format!("could not read {}: {e}", path.display())))?
            .len();
        if size > UPLOAD_LIMIT {
            return Err(SessionError::Invalid(format!(
                "files over {} MB can't be uploaded",
                UPLOAD_LIMIT / 1024 / 1024
            )));
        }
        let bytes = std::fs::read(path).map_err(|e| {
            SessionError::Invalid(format!("could not read {}: {e}", path.display()))
        })?;
        let staged = StagedFile {
            token: uuid::Uuid::new_v4().to_string(),
            size: bytes.len() as u32,
            image: crate::grid::Cell::of(&crate::query::Value::Bytes(bytes.clone())).and_then(
                |cell| match cell {
                    crate::grid::Cell::Binary { image, .. } => image,
                    _ => None,
                },
            ),
        };
        self.uploads.insert(staged.token.clone(), bytes);
        Ok(staged)
    }

    /// Forgets uploaded files once their changes are committed or discarded.
    pub fn discard_uploads(&mut self) {
        self.uploads.clear();
    }

    /// Applies a batch (see the module docs). `confirm` keeps an auto-commit transaction open for
    /// confirm before commit.
    pub async fn apply_edits(
        &mut self,
        batch: &EditBatch,
        confirm: bool,
    ) -> Result<ApplyOutcome, EditFailure> {
        let statements = self.edit_statements(batch)?;
        match self.mode {
            TransactionMode::Auto => self.apply_auto(&statements, confirm).await,
            TransactionMode::Manual => self.apply_manual(&statements).await,
        }
    }

    async fn apply_auto(
        &mut self,
        statements: &[EditStatement],
        confirm: bool,
    ) -> Result<ApplyOutcome, EditFailure> {
        if self.in_transaction {
            return Err(SessionError::Invalid(
                "commit or roll back the open transaction first".into(),
            )
            .into());
        }
        self.begin().await?;

        let ran = match self.run_edits(statements).await {
            Ok(ran) => ran,
            Err(failure) => {
                let _ = self.rollback().await;
                return Err(failure);
            }
        };
        if confirm {
            return Ok(ApplyOutcome {
                state: ApplyState::AwaitingConfirm,
                statements: ran,
                in_transaction: true,
            });
        }

        self.commit().await?;
        self.uploads.clear();
        Ok(ApplyOutcome {
            state: ApplyState::Committed,
            statements: ran,
            in_transaction: false,
        })
    }

    async fn apply_manual(
        &mut self,
        statements: &[EditStatement],
    ) -> Result<ApplyOutcome, EditFailure> {
        let opened = !self.in_transaction;
        if opened {
            self.begin().await?;
        }
        let before = self.transaction.len();

        let ran = match self.execute(&format!("SAVEPOINT {SAVEPOINT}")).await {
            Ok(()) => self.run_edits(statements).await,
            Err(e) => Err(e.into()),
        };
        let ran = match ran {
            Ok(ran) => ran,
            Err(failure) => {
                let undone = async {
                    self.execute(&format!("ROLLBACK TO SAVEPOINT {SAVEPOINT}"))
                        .await?;
                    self.execute(&format!("RELEASE SAVEPOINT {SAVEPOINT}"))
                        .await
                }
                .await;
                self.transaction.truncate(before);
                // A transaction opened for this batch alone has nothing else to keep.
                if opened || undone.is_err() {
                    let _ = self.rollback().await;
                }
                return Err(failure);
            }
        };

        self.execute(&format!("RELEASE SAVEPOINT {SAVEPOINT}"))
            .await?;
        self.uploads.clear();
        Ok(ApplyOutcome {
            state: ApplyState::Applied,
            statements: ran,
            in_transaction: true,
        })
    }

    async fn begin(&mut self) -> Result<(), SessionError> {
        self.ensure_connected().await?;
        self.execute("BEGIN").await?;
        self.in_transaction = true;
        self.transaction.clear();
        Ok(())
    }

    /// Runs each statement through [`Session::run`] (access level, tracking) and checks that it
    /// changed exactly one row.
    async fn run_edits(
        &mut self,
        statements: &[EditStatement],
    ) -> Result<Vec<TransactionStatement>, EditFailure> {
        let mut ran = Vec::new();
        for statement in statements {
            let failed = |error: RunError| EditFailure {
                change: Some(statement.change),
                sql: Some(statement.sql.clone()),
                error,
            };
            let output = self
                .run(&statement.sql, 1)
                .await
                .map_err(|e| failed(e.into()))?;
            let rows = output.rows_affected.unwrap_or(0);
            if rows != 1 {
                let message = if rows == 0 {
                    "the row was changed or deleted since it was loaded".to_owned()
                } else {
                    format!("{rows} rows matched instead of one")
                };
                return Err(failed(RunError::Failed { message }));
            }
            ran.push(TransactionStatement {
                sql: statement.sql.clone(),
                kind: output.kind,
                rows_affected: Some(rows),
            });
        }
        Ok(ran)
    }
}
