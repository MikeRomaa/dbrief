//! Running user statements on a session.
//!
//! Each statement runs in its own task, which owns the connection while it reads. The first page comes
//! back from [`Session::run`]; while more rows remain the task waits, keeping the result open, and
//! [`Session::fetch_more`] asks it for the next page. Anything else on the session closes the open
//! result first and takes the connection back.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Instant;

use async_trait::async_trait;
use serde::Serialize;
use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use tracing::instrument::WithSubscriber as _;

use super::{Session, SessionError};
use crate::classify::{StatementKind, allows, classify};
use crate::engine::{Connector, EngineConnection};
use crate::query::{
    CancelToken, Column, Notice, NoticeCollector, QueryError, ResultSink, Row, RunEnd,
};
use crate::ssh::Endpoint;

/// The first page of a statement's result. `columns` is `None` for statements that return no rows
/// (`rows_affected` then counts changed rows). `more` means Load more has rows to fetch; until it
/// is false, `rows_affected` is unknown.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct RunOutput {
    pub kind: StatementKind,
    pub columns: Option<Vec<Column>>,
    pub rows: Vec<Row>,
    pub more: bool,
    #[cfg_attr(feature = "specta", specta(type = Option<f64>))]
    pub rows_affected: Option<u64>,
    pub duration_ms: f64,
    pub notices: Vec<Notice>,
    pub in_transaction: bool,
}

/// The next page of an open result.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct MoreRows {
    pub rows: Vec<Row>,
    pub more: bool,
    #[cfg_attr(feature = "specta", specta(type = Option<f64>))]
    pub rows_affected: Option<u64>,
    pub notices: Vec<Notice>,
}

enum Message {
    Columns(Vec<Column>),
    Page { rows: Vec<Row>, more: bool },
}

struct ChannelSink {
    messages: mpsc::Sender<Message>,
    next: mpsc::Receiver<()>,
}

#[async_trait]
impl ResultSink for ChannelSink {
    async fn columns(&mut self, columns: Vec<Column>) {
        let _ = self.messages.send(Message::Columns(columns)).await;
    }

    async fn page(&mut self, rows: Vec<Row>, more: bool) -> bool {
        if self
            .messages
            .send(Message::Page { rows, more })
            .await
            .is_err()
        {
            return false;
        }
        // Wait to be asked for the next page; a closed channel means the result was closed.
        !more || self.next.recv().await.is_some()
    }
}

type Running = JoinHandle<(Box<dyn EngineConnection>, Result<RunEnd, sqlx::Error>)>;

/// A result with rows still to fetch; its task holds the connection.
pub(super) struct OpenResult {
    next: mpsc::Sender<()>,
    messages: mpsc::Receiver<Message>,
    task: Running,
    notices: NoticeCollector,
}

/// Stops the statement running on a session without waiting for the session's lock. The token and
/// tunnel endpoint change on reconnect.
#[derive(Clone)]
pub struct CancelHandle {
    connector: Arc<dyn Connector>,
    current: Arc<std::sync::Mutex<(Option<CancelToken>, Option<Endpoint>)>>,
    pub(super) timed_out: Arc<AtomicBool>,
}

impl CancelHandle {
    pub(super) fn new(connector: Arc<dyn Connector>) -> Self {
        Self {
            connector,
            current: Arc::default(),
            timed_out: Arc::default(),
        }
    }

    pub(super) fn update(&self, token: CancelToken, endpoint: Option<Endpoint>) {
        *self.current.lock().unwrap_or_else(|e| e.into_inner()) = (Some(token), endpoint);
    }

    pub(super) fn reset(&self) {
        self.timed_out.store(false, Ordering::SeqCst);
        if let (Some(token), _) = &*self.current.lock().unwrap_or_else(|e| e.into_inner()) {
            token.reset();
        }
    }

    /// Asks the database to stop the running statement. PostgreSQL needs a second, short-lived
    /// connection (through the same tunnel) to call `pg_cancel_backend`.
    pub async fn cancel(&self) -> Result<(), SessionError> {
        let (token, endpoint) = self
            .current
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        match token {
            None => Ok(()),
            Some(CancelToken::Sqlite(flag)) => {
                flag.store(true, Ordering::SeqCst);
                Ok(())
            }
            Some(CancelToken::Postgres { pid }) => {
                let mut conn = self
                    .connector
                    .connect(endpoint.as_ref())
                    .await
                    .map_err(|e| SessionError::Connect(e.to_string()))?;
                let result = conn
                    .execute(&format!("SELECT pg_cancel_backend({pid})"))
                    .await;
                conn.close().await;
                Ok(result?)
            }
        }
    }
}

/// Errors that mean the connection itself is gone, rather than the statement failing.
pub(super) fn connection_lost(e: &sqlx::Error) -> bool {
    matches!(
        e,
        sqlx::Error::Io(_)
            | sqlx::Error::Protocol(_)
            | sqlx::Error::WorkerCrashed
            | sqlx::Error::Tls(_)
    )
}

/// SQLSTATE `query_canceled` (PostgreSQL) and SQLite's `SQLITE_INTERRUPT` message.
pub(super) fn canceled(error: &QueryError) -> bool {
    error.code.as_deref() == Some("57014") || error.message == "interrupted"
}

impl Session {
    /// Runs one statement and returns its first page of `page_size` rows. Statements above the
    /// session's access level are refused before anything is sent. When the connection was lost and
    /// no transaction was open, the session reconnects and runs the statement once more.
    pub async fn run(&mut self, sql: &str, page_size: usize) -> Result<RunOutput, SessionError> {
        let kind = classify(sql, self.info.engine);
        if !allows(self.info.access_level, kind) {
            return Err(SessionError::Blocked {
                kind,
                level: self.info.access_level,
            });
        }

        self.finish_open_result().await;
        self.ensure_connected().await?;
        self.begin_if_needed(sql, kind).await?;

        let mut output = match self.start(sql, page_size, kind).await {
            Err(SessionError::ConnectionLost(_)) if !self.in_transaction => {
                self.ensure_connected().await?;
                self.start(sql, page_size, kind).await
            }
            Err(SessionError::ConnectionLost(_)) => {
                self.in_transaction = false;
                self.transaction_lost = true;
                Err(SessionError::TransactionLost)
            }
            other => other,
        }?;

        self.track(sql, kind, output.rows_affected);
        output.in_transaction = self.in_transaction;
        Ok(output)
    }

    async fn start(
        &mut self,
        sql: &str,
        page_size: usize,
        kind: StatementKind,
    ) -> Result<RunOutput, SessionError> {
        let Some(mut conn) = self.conn.take() else {
            return Err(SessionError::NotFound(self.info.id));
        };
        self.cancel.reset();

        let (messages_tx, mut messages) = mpsc::channel(1);
        let (next, next_rx) = mpsc::channel(1);
        let notices = NoticeCollector::default();
        let owned_sql = sql.to_owned();
        let started = Instant::now();

        let task: Running = tokio::spawn(
            async move {
                let mut sink = ChannelSink {
                    messages: messages_tx,
                    next: next_rx,
                };
                let result = conn.run(&owned_sql, page_size, &mut sink).await;
                (conn, result)
            }
            .with_subscriber(notices.clone()),
        );

        let timer = self.target.query_timeout.map(|timeout| {
            let cancel = self.cancel.clone();
            tokio::spawn(async move {
                tokio::time::sleep(timeout).await;
                cancel.timed_out.store(true, Ordering::SeqCst);
                let _ = cancel.cancel().await;
            })
        });

        let mut columns = None;
        let first = loop {
            match messages.recv().await {
                Some(Message::Columns(c)) => columns = Some(c),
                Some(Message::Page { rows, more }) => break Some((rows, more)),
                None => break None,
            }
        };
        if let Some(timer) = timer {
            timer.abort();
        }
        let duration_ms = started.elapsed().as_secs_f64() * 1000.0;

        let mut output = RunOutput {
            kind,
            columns,
            rows: Vec::new(),
            more: false,
            rows_affected: None,
            duration_ms,
            notices: Vec::new(),
            in_transaction: false,
        };

        if let Some((rows, true)) = first {
            output.rows = rows;
            output.more = true;
            output.notices = notices.take();
            self.open = Some(OpenResult {
                next,
                messages,
                task,
                notices,
            });
            return Ok(output);
        }

        if let Some((rows, false)) = first {
            output.rows = rows;
        }
        let end = self.reclaim(task).await?;
        output.rows_affected = Some(end.rows_affected);
        output.notices = notices.take();
        Ok(output)
    }

    /// The next page of the open result.
    pub async fn fetch_more(&mut self) -> Result<MoreRows, SessionError> {
        let Some(open) = self.open.as_mut() else {
            return Err(SessionError::NoOpenResult);
        };

        let _ = open.next.send(()).await;
        let page = loop {
            match open.messages.recv().await {
                Some(Message::Page { rows, more }) => break Some((rows, more)),
                Some(Message::Columns(_)) => {}
                None => break None,
            }
        };

        if let Some((rows, true)) = page {
            return Ok(MoreRows {
                rows,
                more: true,
                rows_affected: None,
                notices: open.notices.take(),
            });
        }

        let Some(open) = self.open.take() else {
            return Err(SessionError::NoOpenResult);
        };
        let end = self.reclaim(open.task).await?;
        Ok(MoreRows {
            rows: page.map(|(rows, _)| rows).unwrap_or_default(),
            more: false,
            rows_affected: Some(end.rows_affected),
            notices: open.notices.take(),
        })
    }

    /// Closes the open result, if any, and takes the connection back.
    pub async fn close_result(&mut self) {
        self.finish_open_result().await;
    }

    pub(super) async fn finish_open_result(&mut self) {
        if let Some(open) = self.open.take() {
            // Closing both channels makes the task stop reading and hand the connection back.
            drop(open.next);
            drop(open.messages);
            let _ = self.reclaim(open.task).await;
        }
    }

    /// Waits for a statement's task and takes the connection back. A lost connection is closed and
    /// reported as `ConnectionLost`, so the next run reconnects.
    async fn reclaim(&mut self, task: Running) -> Result<RunEnd, SessionError> {
        let (conn, result) = task
            .await
            .map_err(|e| SessionError::Invalid(format!("the statement's task failed: {e}")))?;

        match result {
            Ok(end) => {
                self.conn = Some(conn);
                Ok(end)
            }
            Err(e) if connection_lost(&e) => {
                conn.close().await;
                Err(SessionError::ConnectionLost(e.to_string()))
            }
            Err(e) => {
                self.conn = Some(conn);
                let error = QueryError::from_sqlx(&e);
                if canceled(&error) {
                    let limit = self
                        .target
                        .query_timeout
                        .filter(|_| self.cancel.timed_out.load(Ordering::SeqCst));
                    return Err(match limit {
                        Some(limit) => SessionError::QueryTimeout(limit),
                        None => SessionError::Canceled,
                    });
                }
                Err(SessionError::Query(error))
            }
        }
    }

    /// Reconnects when the connection was lost, unless a transaction was open: that has to be
    /// acknowledged first (see [`Session::reconnect_after_lost_transaction`]).
    pub(super) async fn ensure_connected(&mut self) -> Result<(), SessionError> {
        if self.transaction_lost {
            return Err(SessionError::TransactionLost);
        }
        if self.conn.is_some() {
            return Ok(());
        }
        if self.in_transaction {
            self.in_transaction = false;
            self.transaction_lost = true;
            return Err(SessionError::TransactionLost);
        }

        self.reconnect().await
    }
}

/// A failed run as the UI handles it: a database error with its detail, a statement the access level
/// doesn't allow, a cancel or timeout, a lost transaction to acknowledge, or anything else as text.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum RunError {
    Query {
        error: QueryError,
    },
    Blocked {
        message: String,
        statement: StatementKind,
        level: crate::connections::AccessLevel,
    },
    Canceled {
        message: String,
    },
    TransactionLost {
        message: String,
    },
    Failed {
        message: String,
    },
}

impl From<SessionError> for RunError {
    fn from(e: SessionError) -> Self {
        let message = e.to_string();
        match e {
            SessionError::Query(error) => Self::Query { error },
            SessionError::Blocked { kind, level } => Self::Blocked {
                message,
                statement: kind,
                level,
            },
            SessionError::Canceled | SessionError::QueryTimeout(_) => Self::Canceled { message },
            SessionError::TransactionLost => Self::TransactionLost { message },
            _ => Self::Failed { message },
        }
    }
}

/// Rows read at a time while exporting.
const EXPORT_PAGE: usize = 1000;

impl Session {
    /// Runs a read statement again and writes every row to `writer`. Writes and DDL aren't exported,
    /// since running them again would change data.
    pub async fn export(
        &mut self,
        sql: &str,
        writer: &mut crate::export::ExportWriter,
    ) -> Result<(), SessionError> {
        if classify(sql, self.info.engine) != StatementKind::Read {
            return Err(SessionError::Invalid(
                "only read statements can be exported".into(),
            ));
        }

        self.finish_open_result().await;
        self.ensure_connected().await?;
        let conn = self
            .conn
            .as_mut()
            .ok_or(SessionError::NotFound(self.info.id))?;
        conn.run(sql, EXPORT_PAGE, writer)
            .await
            .map_err(|e| SessionError::Query(QueryError::from_sqlx(&e)))?;
        Ok(())
    }
}
