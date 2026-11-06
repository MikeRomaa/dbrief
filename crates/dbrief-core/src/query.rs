//! Running user SQL: results as pages of text rows, errors with the database's detail, and server
//! notices. Engines produce results through a [`ResultSink`]; sessions keep a result open between
//! pages (see `session`).

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use futures_util::{Stream, TryStreamExt};
use serde::Serialize;
use sqlx::Either;
use sqlx::postgres::{PgDatabaseError, PgErrorPosition};

/// A result column and its database type name (e.g. `int4`, `TEXT`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct Column {
    pub name: String,
    pub type_name: String,
}

/// One row as display text; `None` is SQL NULL.
pub type Row = Vec<Option<String>>;

/// An error from the database, with PostgreSQL's code, detail, hint and position (1-based character
/// offset into the statement) when it gives them.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct QueryError {
    pub message: String,
    pub code: Option<String>,
    pub detail: Option<String>,
    pub hint: Option<String>,
    pub position: Option<u32>,
}

impl QueryError {
    pub fn from_sqlx(e: &sqlx::Error) -> Self {
        let sqlx::Error::Database(db) = e else {
            return Self {
                message: e.to_string(),
                ..Self::default()
            };
        };

        let mut error = Self {
            message: db.message().to_string(),
            code: db.code().map(|c| c.into_owned()),
            ..Self::default()
        };
        if let Some(pg) = db.try_downcast_ref::<PgDatabaseError>() {
            error.detail = pg.detail().map(str::to_owned);
            error.hint = pg.hint().map(str::to_owned);
            if let Some(PgErrorPosition::Original(p)) = pg.position() {
                error.position = u32::try_from(p).ok();
            }
        }
        error
    }
}

/// A server notice (PostgreSQL `RAISE NOTICE`, warnings) with its level: notice, warning, info, …
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct Notice {
    pub level: String,
    pub message: String,
}

/// Receives a statement's results while it runs. `page` returns false to stop reading (the result was
/// closed); the engine then returns early.
#[async_trait]
pub trait ResultSink: Send {
    async fn columns(&mut self, columns: Vec<Column>);

    /// A page of rows; `more` is true when at least one more row follows.
    async fn page(&mut self, rows: Vec<Row>, more: bool) -> bool;
}

/// How a statement ended: rows affected (for writes) and whether it returned a row set.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct RunEnd {
    pub rows_affected: u64,
    pub returned_rows: bool,
    pub stopped: bool,
}

/// Reads a sqlx result stream into pages of `page_size` rows, holding one row back to know whether
/// more follow.
pub(crate) async fn drive<S, R, Q>(
    mut stream: S,
    page_size: usize,
    sink: &mut dyn ResultSink,
    columns: impl Fn(&R) -> Vec<Column>,
    row: impl Fn(&R) -> Row,
    affected: impl Fn(&Q) -> u64,
) -> Result<RunEnd, sqlx::Error>
where
    S: Stream<Item = Result<Either<Q, R>, sqlx::Error>> + Unpin,
{
    let page_size = page_size.max(1);
    let mut end = RunEnd::default();
    let mut buffer: Vec<Row> = Vec::with_capacity(page_size);

    while let Some(item) = stream.try_next().await? {
        match item {
            Either::Left(result) => end.rows_affected += affected(&result),
            Either::Right(r) => {
                if !end.returned_rows {
                    sink.columns(columns(&r)).await;
                    end.returned_rows = true;
                }

                if buffer.len() == page_size && !sink.page(std::mem::take(&mut buffer), true).await
                {
                    end.stopped = true;
                    return Ok(end);
                }
                buffer.push(row(&r));
            }
        }
    }

    if end.returned_rows {
        sink.page(buffer, false).await;
    }
    Ok(end)
}

/// What stops a running statement: PostgreSQL's backend pid (cancelled from a second connection),
/// or SQLite's interrupt flag (checked by a progress handler).
#[derive(Clone, Debug)]
pub enum CancelToken {
    Postgres { pid: i32 },
    Sqlite(Arc<AtomicBool>),
}

impl CancelToken {
    /// Clears a SQLite interrupt left from the last statement.
    pub fn reset(&self) {
        if let Self::Sqlite(flag) = self {
            flag.store(false, Ordering::SeqCst);
        }
    }
}

/// Collects PostgreSQL notices for one running statement. sqlx reports notices only as `tracing`
/// events (target `sqlx::postgres::notice`); running the statement's task with this as its
/// subscriber attributes them to that statement.
#[derive(Clone, Default)]
pub struct NoticeCollector {
    notices: Arc<Mutex<Vec<Notice>>>,
}

impl NoticeCollector {
    const TARGET: &'static str = "sqlx::postgres::notice";

    pub fn take(&self) -> Vec<Notice> {
        std::mem::take(&mut *self.notices.lock().unwrap_or_else(|e| e.into_inner()))
    }
}

impl tracing::Subscriber for NoticeCollector {
    fn enabled(&self, metadata: &tracing::Metadata<'_>) -> bool {
        metadata.target() == Self::TARGET
    }

    fn max_level_hint(&self) -> Option<tracing::level_filters::LevelFilter> {
        Some(tracing::level_filters::LevelFilter::TRACE)
    }

    fn new_span(&self, _: &tracing::span::Attributes<'_>) -> tracing::span::Id {
        tracing::span::Id::from_u64(1)
    }

    fn record(&self, _: &tracing::span::Id, _: &tracing::span::Record<'_>) {}

    fn record_follows_from(&self, _: &tracing::span::Id, _: &tracing::span::Id) {}

    fn event(&self, event: &tracing::Event<'_>) {
        if event.metadata().target() != Self::TARGET {
            return;
        }

        struct Message(String);
        impl tracing::field::Visit for Message {
            fn record_str(&mut self, field: &tracing::field::Field, value: &str) {
                if field.name() == "message" {
                    self.0 = value.to_owned();
                }
            }

            fn record_debug(&mut self, field: &tracing::field::Field, value: &dyn std::fmt::Debug) {
                if field.name() == "message" {
                    self.0 = format!("{value:?}");
                }
            }
        }

        let mut message = Message(String::new());
        event.record(&mut message);
        let level = match *event.metadata().level() {
            tracing::Level::ERROR => "error",
            tracing::Level::WARN => "warning",
            tracing::Level::INFO => "notice",
            tracing::Level::DEBUG => "debug",
            tracing::Level::TRACE => "info",
        };
        self.notices
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .push(Notice {
                level: level.to_owned(),
                message: message.0,
            });
    }

    fn enter(&self, _: &tracing::span::Id) {}

    fn exit(&self, _: &tracing::span::Id) {}
}
