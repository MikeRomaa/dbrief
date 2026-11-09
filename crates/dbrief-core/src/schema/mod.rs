//! A connection's schema: loading it from the database's catalogs, the local cache that keeps it for
//! the Explorer, search and autocomplete, and the live structure and DDL of one object.
//!
//! `schema` names a PostgreSQL schema, or a SQLite database ("main" or an attached one).

mod cache;
mod postgres;
mod sqlite;
mod structure;

#[cfg(test)]
mod tests;

use serde::{Deserialize, Serialize};

pub use cache::{SchemaCache, SearchHit, SearchKind, fuzzy_score};
pub use structure::{ConstraintInfo, IndexInfo, TableStructure, TriggerInfo};

use crate::connections::Engine;
use crate::session::{Session, SessionError};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "kebab-case")]
pub enum ObjectKind {
    /// A PostgreSQL schema, listed so empty schemas still show.
    Schema,
    Table,
    View,
    MaterializedView,
    Function,
    Sequence,
    Index,
    Trigger,
}

impl ObjectKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Schema => "schema",
            Self::Table => "table",
            Self::View => "view",
            Self::MaterializedView => "materialized-view",
            Self::Function => "function",
            Self::Sequence => "sequence",
            Self::Index => "index",
            Self::Trigger => "trigger",
        }
    }

    pub fn parse(text: &str) -> Option<Self> {
        [
            Self::Schema,
            Self::Table,
            Self::View,
            Self::MaterializedView,
            Self::Function,
            Self::Sequence,
            Self::Index,
            Self::Trigger,
        ]
        .into_iter()
        .find(|k| k.as_str() == text)
    }

    /// Tables and views: things with columns and rows.
    pub fn has_rows(self) -> bool {
        matches!(self, Self::Table | Self::View | Self::MaterializedView)
    }
}

/// One database object. `parent` is the table of an index or trigger; `detail` holds a function's
/// arguments and result. Estimates come from the database's statistics and are `None` when it has
/// none.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct SchemaObject {
    pub schema: String,
    pub name: String,
    pub kind: ObjectKind,
    pub parent: Option<String>,
    pub detail: Option<String>,
    #[cfg_attr(feature = "specta", specta(type = Option<f64>))]
    pub estimated_rows: Option<i64>,
    #[cfg_attr(feature = "specta", specta(type = Option<f64>))]
    pub size_bytes: Option<i64>,
}

/// A table or view column. `ordinal` is its position (PostgreSQL's `attnum`, which can have gaps);
/// `pk_ordinal` its 1-based position in the primary key.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct SchemaColumn {
    pub schema: String,
    pub table_name: String,
    pub ordinal: u32,
    pub name: String,
    pub type_name: String,
    pub nullable: bool,
    pub default_value: Option<String>,
    pub pk_ordinal: Option<u32>,
}

/// Everything loaded from a database in one refresh.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Snapshot {
    pub objects: Vec<SchemaObject>,
    pub columns: Vec<SchemaColumn>,
}

/// Names one object of a connection. `detail` tells overloaded functions apart.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct ObjectRef {
    pub schema: String,
    pub name: String,
    pub kind: ObjectKind,
    pub detail: Option<String>,
}

/// Reads the whole schema through `session` (the connection's background session).
pub async fn load(session: &mut Session) -> Result<Snapshot, SessionError> {
    match session.info().engine {
        Engine::Postgres => postgres::load(session).await,
        Engine::Sqlite => sqlite::load(session).await,
    }
}

/// Columns, indexes, constraints and triggers of a table or view.
pub async fn structure(
    session: &mut Session,
    object: &ObjectRef,
) -> Result<TableStructure, SessionError> {
    match session.info().engine {
        Engine::Postgres => postgres::structure(session, object).await,
        Engine::Sqlite => sqlite::structure(session, object).await,
    }
}

/// Row identity and columns of a table, for editing it in the grid. Views, RO connections and
/// tables whose rows can't be told apart are read-only, with the reason.
pub async fn edit_info(
    session: &mut Session,
    object: &ObjectRef,
) -> Result<crate::edit::EditInfo, SessionError> {
    let (columns, candidates, rowid_table) = match session.info().engine {
        Engine::Postgres => {
            let (columns, candidates) = postgres::edit_facts(session, object).await?;
            (columns, candidates, false)
        }
        Engine::Sqlite => sqlite::edit_facts(session, object).await?,
    };
    if columns.is_empty() {
        return Err(not_found(object));
    }

    let mut read_only = match object.kind {
        ObjectKind::Table => None,
        ObjectKind::View => Some("Views are read-only.".to_owned()),
        ObjectKind::MaterializedView => Some("Materialized views are read-only.".to_owned()),
        _ => Some("Only tables can be edited.".to_owned()),
    };
    if read_only.is_none() && session.info().access_level == crate::connections::AccessLevel::Ro {
        read_only = Some("The connection is read-only (RO).".to_owned());
    }
    let identity = read_only
        .is_none()
        .then(|| crate::edit::pick_identity(&candidates, &columns, rowid_table))
        .flatten();
    if read_only.is_none() && identity.is_none() {
        read_only = Some(
            "Read-only: no primary key or unique index on non-null columns, so rows can't be told apart."
                .to_owned(),
        );
    }

    Ok(crate::edit::EditInfo {
        identity,
        read_only,
        columns,
    })
}

/// The SQL that creates the object (with a table's indexes and triggers).
pub async fn ddl(session: &mut Session, object: &ObjectRef) -> Result<String, SessionError> {
    match session.info().engine {
        Engine::Postgres => postgres::ddl(session, object).await,
        Engine::Sqlite => sqlite::ddl(session, object).await,
    }
}

/// An identifier in double quotes, which both engines accept.
pub fn quote_ident(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

/// A string literal in single quotes.
pub fn quote_literal(text: &str) -> String {
    format!("'{}'", text.replace('\'', "''"))
}

/// `"schema"."name"`.
pub fn qualified(schema: &str, name: &str) -> String {
    format!("{}.{}", quote_ident(schema), quote_ident(name))
}

/// An error for an object a structure or DDL request didn't find.
fn not_found(object: &ObjectRef) -> SessionError {
    SessionError::Invalid(format!(
        "{} {}.{} was not found",
        object.kind.as_str(),
        object.schema,
        object.name
    ))
}

/// One row of a catalog query, read by column name.
pub(crate) struct Record<'a> {
    values: &'a crate::query::Values,
    row: &'a [crate::query::Value],
}

impl Record<'_> {
    fn value(&self, column: &str) -> Option<&crate::query::Value> {
        self.row.get(self.values.column(column)?)
    }

    pub(crate) fn text(&self, column: &str) -> Option<String> {
        self.value(column)?.as_text().map(str::to_owned)
    }

    /// The text, or an empty string for NULL.
    pub(crate) fn string(&self, column: &str) -> String {
        self.text(column).unwrap_or_default()
    }

    pub(crate) fn int(&self, column: &str) -> Option<i64> {
        self.value(column)?.as_i64()
    }

    /// Whole numbers that PostgreSQL may print as floats (`reltuples` is `real`).
    pub(crate) fn whole(&self, column: &str) -> Option<i64> {
        self.int(column)
            .or_else(|| self.value(column)?.as_f64().map(|f| f.round() as i64))
    }

    pub(crate) fn bool(&self, column: &str) -> bool {
        self.value(column).is_some_and(crate::query::Value::as_bool)
    }
}

pub(crate) fn records(values: &crate::query::Values) -> impl Iterator<Item = Record<'_>> {
    values.rows.iter().map(move |row| Record { values, row })
}
