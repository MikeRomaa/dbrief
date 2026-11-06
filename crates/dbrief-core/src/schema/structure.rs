//! The structure of one table or view, as the table tab's Columns, Indices, Constraints and Triggers
//! views show it. Loaded live, not cached.

use serde::Serialize;

use super::SchemaColumn;

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct TableStructure {
    pub columns: Vec<SchemaColumn>,
    pub indexes: Vec<IndexInfo>,
    pub constraints: Vec<ConstraintInfo>,
    pub triggers: Vec<TriggerInfo>,
}

/// `columns` lists the indexed columns or expressions; `definition` is the statement that creates
/// the index, when the database has one (SQLite's automatic indexes don't).
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct IndexInfo {
    pub name: String,
    pub columns: String,
    pub unique: bool,
    pub primary: bool,
    pub definition: Option<String>,
}

/// `kind` is "primary key", "unique", "foreign key", "check" or "exclusion"; `definition` is the
/// constraint's clause, e.g. `FOREIGN KEY (a) REFERENCES t (id) ON DELETE CASCADE`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct ConstraintInfo {
    pub name: Option<String>,
    pub kind: String,
    pub definition: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct TriggerInfo {
    pub name: String,
    pub enabled: bool,
    pub definition: String,
}
