//! Editing table data from the grid: which rows can be told apart (row identity), which columns can
//! be written, and the statements that apply a batch of staged changes.
//!
//! Staged changes live in the frontend and point at rows of the page the session keeps, so original
//! values never travel back over IPC. The statements are built here from that page.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::connections::Engine;
use crate::query::{Value, Values};
use crate::schema::{qualified, quote_ident};
use crate::session::SessionError;

/// SQLite names for a rowid table's row id, tried in order; a column can shadow each of them.
pub const ROWID_ALIASES: [&str; 3] = ["rowid", "_rowid_", "oid"];

/// How a table's rows are told apart: key columns (a primary key or a unique index on non-null
/// columns), or a SQLite rowid under `rowid`, the first of [`ROWID_ALIASES`] no column shadows.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum RowIdentity {
    Key {
        columns: Vec<String>,
        index: Option<String>,
    },
    Rowid {
        rowid: String,
    },
}

/// A column as editing sees it. `type_name` is the declared type; `base_type` is a domain's
/// underlying type (the same as `type_name` otherwise), which picks the editor. `writable` is false
/// for generated columns and `GENERATED ALWAYS` identity columns.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct EditColumn {
    pub name: String,
    pub type_name: String,
    pub base_type: String,
    pub nullable: bool,
    pub default_value: Option<String>,
    pub writable: bool,
}

/// What the grid needs to edit a table: its row identity and columns. `read_only` says why the
/// table can't be edited (a view, an RO connection, no key); `identity` is then `None`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct EditInfo {
    pub identity: Option<RowIdentity>,
    pub read_only: Option<String>,
    pub columns: Vec<EditColumn>,
}

/// A unique index (or the primary key) as a candidate row identity. `columns` is `None` when it
/// covers an expression.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct KeyCandidate {
    pub name: String,
    pub primary: bool,
    pub partial: bool,
    pub columns: Option<Vec<String>>,
}

/// Picks the row identity: the primary key, else the unique index with the fewest columns (then by
/// name) that is not partial, has no expressions and covers only non-null columns, else `rowid`
/// when the table has one.
pub fn pick_identity(
    candidates: &[KeyCandidate],
    columns: &[EditColumn],
    rowid_table: bool,
) -> Option<RowIdentity> {
    let not_null = |name: &String| columns.iter().any(|c| &c.name == name && !c.nullable);

    if let Some(primary) = candidates.iter().find(|c| c.primary && c.columns.is_some()) {
        return Some(RowIdentity::Key {
            columns: primary.columns.clone().unwrap_or_default(),
            index: None,
        });
    }

    let mut unique: Vec<&KeyCandidate> = candidates
        .iter()
        .filter(|c| !c.partial)
        .filter(|c| {
            c.columns
                .as_ref()
                .is_some_and(|cols| !cols.is_empty() && cols.iter().all(not_null))
        })
        .collect();
    unique.sort_by(|a, b| {
        let len = |c: &KeyCandidate| c.columns.as_ref().map_or(0, Vec::len);
        len(a).cmp(&len(b)).then_with(|| a.name.cmp(&b.name))
    });
    if let Some(index) = unique.first() {
        return Some(RowIdentity::Key {
            columns: index.columns.clone().unwrap_or_default(),
            index: Some(index.name.clone()),
        });
    }

    if !rowid_table {
        return None;
    }
    ROWID_ALIASES
        .iter()
        .find(|alias| !columns.iter().any(|c| c.name.eq_ignore_ascii_case(alias)))
        .map(|alias| RowIdentity::Rowid {
            rowid: (*alias).to_owned(),
        })
}

/// A staged value. `Original` is the original value of the same column in another page row (fill
/// down, duplicate row), so cut-short and binary values copy whole. `File` is an uploaded binary
/// value held by the session.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum NewValue {
    Null,
    Default,
    Text { text: String },
    Original { row: u32 },
    File { token: String },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct ColumnValue {
    pub column: String,
    pub value: NewValue,
}

/// One staged change. `row` indexes the session's loaded page.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum Change {
    Update { row: u32, values: Vec<ColumnValue> },
    Insert { values: Vec<ColumnValue> },
    Delete { row: u32 },
}

/// Staged changes for one table, with the identity and columns from [`EditInfo`].
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct EditBatch {
    pub schema: String,
    pub name: String,
    pub identity: RowIdentity,
    pub columns: Vec<EditColumn>,
    pub changes: Vec<Change>,
}

/// A statement for one change; `change` indexes [`EditBatch::changes`].
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct EditStatement {
    pub sql: String,
    pub change: u32,
}

/// What a statement builder reads besides the batch: the page, its rowids, and uploads.
pub struct PageSource<'a> {
    pub page: &'a Values,
    pub rowids: &'a [Value],
    pub uploads: &'a HashMap<String, Vec<u8>>,
}

fn invalid(message: impl Into<String>) -> SessionError {
    SessionError::Invalid(message.into())
}

/// SQLite's column affinity from a declared type (the rules of section 3.1 of its datatype docs).
fn sqlite_numeric(type_name: &str) -> bool {
    let t = type_name.to_ascii_uppercase();
    if t.contains("INT") {
        return true;
    }
    if t.contains("CHAR") || t.contains("CLOB") || t.contains("TEXT") {
        return false;
    }
    if t.is_empty() || t.contains("BLOB") {
        return false;
    }
    true
}

/// PostgreSQL types whose plain numbers can be written unquoted.
fn pg_numeric(type_name: &str) -> bool {
    let t = type_name.to_ascii_lowercase();
    !t.ends_with("[]")
        && [
            "smallint",
            "integer",
            "bigint",
            "int2",
            "int4",
            "int8",
            "real",
            "double precision",
            "float4",
            "float8",
            "numeric",
            "decimal",
        ]
        .iter()
        .any(|n| t == *n || t.starts_with(&format!("{n}(")))
}

/// A plain decimal number: digits with an optional sign, fraction and exponent.
fn plain_number(text: &str) -> bool {
    let rest = text.strip_prefix('-').unwrap_or(text);
    let (mantissa, exponent) = match rest.find(['e', 'E']) {
        Some(i) => (&rest[..i], Some(&rest[i + 1..])),
        None => (rest, None),
    };
    let (whole, fraction) = mantissa.split_once('.').unwrap_or((mantissa, ""));
    let digits = |s: &str| s.chars().all(|c| c.is_ascii_digit());
    let exponent_ok = exponent.is_none_or(|e| {
        let e = e.strip_prefix(['+', '-']).unwrap_or(e);
        !e.is_empty() && digits(e)
    });
    !whole.is_empty() && digits(whole) && digits(fraction) && exponent_ok
}

fn text_literal(engine: Engine, text: &str) -> String {
    let quoted = text.replace('\'', "''");
    // `E'…'` reads backslashes the same whatever standard_conforming_strings is set to.
    if engine == Engine::Postgres && text.contains('\\') {
        format!("E'{}'", quoted.replace('\\', "\\\\"))
    } else {
        format!("'{quoted}'")
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn bytes_literal(engine: Engine, bytes: &[u8]) -> String {
    match engine {
        Engine::Postgres => format!("decode('{}', 'hex')", hex(bytes)),
        Engine::Sqlite => format!("X'{}'", hex(bytes)),
    }
}

struct Builder<'a> {
    engine: Engine,
    batch: &'a EditBatch,
    source: &'a PageSource<'a>,
}

impl Builder<'_> {
    fn column(&self, name: &str) -> Result<&EditColumn, SessionError> {
        self.batch
            .columns
            .iter()
            .find(|c| c.name == name)
            .ok_or_else(|| invalid(format!("column {name} is not in the table")))
    }

    fn numeric(&self, column: &EditColumn) -> bool {
        match self.engine {
            Engine::Postgres => pg_numeric(&column.base_type),
            Engine::Sqlite => sqlite_numeric(&column.type_name),
        }
    }

    fn page_value(&self, row: u32, column: &str) -> Result<&Value, SessionError> {
        let index = self
            .source
            .page
            .column(column)
            .ok_or_else(|| invalid(format!("column {column} is not on the loaded page")))?;
        self.source
            .page
            .rows
            .get(row as usize)
            .and_then(|r| r.get(index))
            .ok_or_else(|| invalid("that row is not on the loaded page"))
    }

    /// A value read from the page as a literal. SQLite numbers keep their storage class.
    fn value_literal(&self, column: &EditColumn, value: &Value) -> String {
        match value {
            Value::Null => "NULL".to_owned(),
            Value::Number(n) => n.clone(),
            Value::Text(t) if self.numeric(column) && plain_number(t) => t.clone(),
            Value::Text(t) => text_literal(self.engine, t),
            Value::Bytes(b) => bytes_literal(self.engine, b),
        }
    }

    /// A staged value as a literal; `None` for DEFAULT. `original` is the value being replaced: in a
    /// SQLite column without a declared type, a number stays a number.
    fn new_literal(
        &self,
        column: &EditColumn,
        value: &NewValue,
        original: Option<&Value>,
    ) -> Result<Option<String>, SessionError> {
        let keeps_number = matches!(original, Some(Value::Number(_)));
        Ok(Some(match value {
            NewValue::Null => "NULL".to_owned(),
            NewValue::Default => return Ok(None),
            NewValue::Text { text }
                if (self.numeric(column) || keeps_number) && plain_number(text) =>
            {
                text.clone()
            }
            NewValue::Text { text } => text_literal(self.engine, text),
            NewValue::Original { row } => {
                self.value_literal(column, self.page_value(*row, &column.name)?)
            }
            NewValue::File { token } => {
                let bytes = self
                    .source
                    .uploads
                    .get(token)
                    .ok_or_else(|| invalid("the uploaded file is no longer available"))?;
                bytes_literal(self.engine, bytes)
            }
        }))
    }

    fn writable(&self, name: &str) -> Result<&EditColumn, SessionError> {
        let column = self.column(name)?;
        if !column.writable {
            return Err(invalid(format!("column {name} can't be written")));
        }
        Ok(column)
    }

    /// `WHERE` matching one page row by its identity.
    fn row_match(&self, row: u32) -> Result<String, SessionError> {
        match &self.batch.identity {
            RowIdentity::Rowid { rowid } => {
                let value = self
                    .source
                    .rowids
                    .get(row as usize)
                    .ok_or_else(|| invalid("that row is not on the loaded page"))?;
                let literal = match value {
                    Value::Number(n) | Value::Text(n) => n.clone(),
                    _ => return Err(invalid("the row has no rowid")),
                };
                Ok(format!("{rowid} = {literal}"))
            }
            RowIdentity::Key { columns, .. } => {
                let parts = columns
                    .iter()
                    .map(|name| {
                        let column = self.column(name)?;
                        let value = self.page_value(row, name)?;
                        Ok(match value {
                            Value::Null => format!("{} IS NULL", quote_ident(name)),
                            _ => format!(
                                "{} = {}",
                                quote_ident(name),
                                self.value_literal(column, value)
                            ),
                        })
                    })
                    .collect::<Result<Vec<_>, SessionError>>()?;
                Ok(parts.join(" AND "))
            }
        }
    }

    fn delete(&self, row: u32) -> Result<String, SessionError> {
        Ok(format!(
            "DELETE FROM {} WHERE {}",
            self.target(),
            self.row_match(row)?
        ))
    }

    fn update(&self, row: u32, values: &[ColumnValue]) -> Result<String, SessionError> {
        if values.is_empty() {
            return Err(invalid("an update needs at least one value"));
        }
        let sets = values
            .iter()
            .map(|v| {
                let column = self.writable(&v.column)?;
                let original = self.page_value(row, &v.column)?;
                let literal = match self.new_literal(column, &v.value, Some(original))? {
                    Some(literal) => literal,
                    // SQLite has no DEFAULT in UPDATE; its default is an expression we can repeat.
                    None if self.engine == Engine::Sqlite => match &column.default_value {
                        Some(default) => format!("({default})"),
                        None => "NULL".to_owned(),
                    },
                    None => "DEFAULT".to_owned(),
                };
                Ok(format!("{} = {literal}", quote_ident(&v.column)))
            })
            .collect::<Result<Vec<_>, SessionError>>()?;
        Ok(format!(
            "UPDATE {} SET {} WHERE {}",
            self.target(),
            sets.join(", "),
            self.row_match(row)?
        ))
    }

    fn insert(&self, values: &[ColumnValue]) -> Result<String, SessionError> {
        let mut names = Vec::new();
        let mut literals = Vec::new();
        for v in values {
            let column = self.writable(&v.column)?;
            if let Some(literal) = self.new_literal(column, &v.value, None)? {
                names.push(quote_ident(&v.column));
                literals.push(literal);
            }
        }
        if names.is_empty() {
            return Ok(format!("INSERT INTO {} DEFAULT VALUES", self.target()));
        }
        Ok(format!(
            "INSERT INTO {} ({}) VALUES ({})",
            self.target(),
            names.join(", "),
            literals.join(", ")
        ))
    }

    fn target(&self) -> String {
        qualified(&self.batch.schema, &self.batch.name)
    }
}

/// The statements for a batch: deletes, then updates, then inserts, so a deleted key can be inserted
/// again in the same batch.
pub fn statements(
    engine: Engine,
    batch: &EditBatch,
    source: &PageSource<'_>,
) -> Result<Vec<EditStatement>, SessionError> {
    let builder = Builder {
        engine,
        batch,
        source,
    };
    let mut out = Vec::new();
    for pass in 0..3 {
        for (i, change) in batch.changes.iter().enumerate() {
            let sql = match (pass, change) {
                (0, Change::Delete { row }) => builder.delete(*row)?,
                (1, Change::Update { row, values }) => builder.update(*row, values)?,
                (2, Change::Insert { values }) => builder.insert(values)?,
                _ => continue,
            };
            out.push(EditStatement {
                sql,
                change: i as u32,
            });
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::query::Column;

    fn column(name: &str, type_name: &str, nullable: bool) -> EditColumn {
        EditColumn {
            name: name.into(),
            type_name: type_name.into(),
            base_type: type_name.into(),
            nullable,
            default_value: None,
            writable: true,
        }
    }

    fn candidate(name: &str, primary: bool, partial: bool, cols: Option<&[&str]>) -> KeyCandidate {
        KeyCandidate {
            name: name.into(),
            primary,
            partial,
            columns: cols.map(|c| c.iter().map(|s| (*s).to_owned()).collect()),
        }
    }

    #[test]
    fn picks_the_primary_key_then_a_usable_unique_index_then_rowid() {
        let columns = [
            column("a", "int", false),
            column("b", "int", false),
            column("c", "int", true),
        ];
        let pk = candidate("pk", true, false, Some(&["b", "a"]));
        let wide = candidate("u_ab", false, false, Some(&["a", "b"]));
        let narrow = candidate("u_b", false, false, Some(&["b"]));
        let nullable = candidate("u_c", false, false, Some(&["c"]));
        let partial = candidate("u_a_partial", false, true, Some(&["a"]));
        let expression = candidate("u_expr", false, false, None);

        assert_eq!(
            pick_identity(&[narrow.clone(), pk], &columns, true),
            Some(RowIdentity::Key {
                columns: vec!["b".into(), "a".into()],
                index: None
            })
        );
        assert_eq!(
            pick_identity(
                &[
                    wide.clone(),
                    narrow,
                    nullable.clone(),
                    partial.clone(),
                    expression.clone()
                ],
                &columns,
                false
            ),
            Some(RowIdentity::Key {
                columns: vec!["b".into()],
                index: Some("u_b".into())
            })
        );
        assert_eq!(
            pick_identity(&[nullable, partial, expression], &columns, false),
            None
        );
    }

    #[test]
    fn rowid_skips_shadowed_names() {
        let mut columns = vec![column("x", "", true)];
        assert_eq!(
            pick_identity(&[], &columns, true),
            Some(RowIdentity::Rowid {
                rowid: "rowid".into()
            })
        );
        columns.push(column("ROWID", "", true));
        columns.push(column("_rowid_", "", true));
        assert_eq!(
            pick_identity(&[], &columns, true),
            Some(RowIdentity::Rowid {
                rowid: "oid".into()
            })
        );
        columns.push(column("oid", "", true));
        assert_eq!(pick_identity(&[], &columns, true), None);
    }

    fn page() -> Values {
        Values {
            columns: vec![
                Column {
                    name: "id".into(),
                    type_name: "INT4".into(),
                },
                Column {
                    name: "note".into(),
                    type_name: "TEXT".into(),
                },
                Column {
                    name: "data".into(),
                    type_name: "BYTEA".into(),
                },
            ],
            rows: vec![
                vec![
                    Value::Text("1".into()),
                    Value::Text("it's".into()),
                    Value::Bytes(vec![0xde, 0xad]),
                ],
                vec![Value::Number("2".into()), Value::Null, Value::Null],
            ],
        }
    }

    fn batch(engine: Engine, changes: Vec<Change>) -> EditBatch {
        let note_type = if engine == Engine::Postgres {
            "text"
        } else {
            "TEXT"
        };
        EditBatch {
            schema: "public".into(),
            name: "my \"t\"".into(),
            identity: RowIdentity::Key {
                columns: vec!["id".into()],
                index: None,
            },
            columns: vec![
                column("id", "integer", false),
                EditColumn {
                    default_value: Some("'none'".into()),
                    ..column("note", note_type, true)
                },
                column("data", "bytea", true),
                EditColumn {
                    writable: false,
                    ..column("total", "integer", true)
                },
            ],
            changes,
        }
    }

    fn build(engine: Engine, changes: Vec<Change>) -> Result<Vec<String>, SessionError> {
        let page = page();
        let uploads = HashMap::from([("f1".to_owned(), vec![0x01, 0xff])]);
        let source = PageSource {
            page: &page,
            rowids: &[Value::Number("10".into()), Value::Number("11".into())],
            uploads: &uploads,
        };
        statements(engine, &batch(engine, changes), &source)
            .map(|s| s.into_iter().map(|s| s.sql).collect())
    }

    fn set(column: &str, value: NewValue) -> ColumnValue {
        ColumnValue {
            column: column.into(),
            value,
        }
    }

    fn text(t: &str) -> NewValue {
        NewValue::Text { text: t.into() }
    }

    #[test]
    fn orders_deletes_updates_inserts() {
        let sql = build(
            Engine::Postgres,
            vec![
                Change::Insert {
                    values: vec![set("id", text("1")), set("note", text("again"))],
                },
                Change::Update {
                    row: 1,
                    values: vec![set("note", text("x"))],
                },
                Change::Delete { row: 0 },
            ],
        )
        .unwrap();
        assert_eq!(
            sql,
            [
                r#"DELETE FROM "public"."my ""t""" WHERE "id" = 1"#,
                r#"UPDATE "public"."my ""t""" SET "note" = 'x' WHERE "id" = 2"#,
                r#"INSERT INTO "public"."my ""t""" ("id", "note") VALUES (1, 'again')"#,
            ]
        );
    }

    #[test]
    fn writes_literals_for_each_engine() {
        let values = vec![
            set("note", text("a'b\\c")),
            set("data", NewValue::File { token: "f1".into() }),
        ];
        let pg = build(
            Engine::Postgres,
            vec![Change::Update {
                row: 0,
                values: values.clone(),
            }],
        )
        .unwrap();
        assert_eq!(
            pg[0],
            r#"UPDATE "public"."my ""t""" SET "note" = E'a''b\\c', "data" = decode('01ff', 'hex') WHERE "id" = 1"#
        );
        let lite = build(Engine::Sqlite, vec![Change::Update { row: 0, values }]).unwrap();
        assert_eq!(
            lite[0],
            r#"UPDATE "public"."my ""t""" SET "note" = 'a''b\c', "data" = X'01ff' WHERE "id" = 1"#
        );

        // Empty text, Unicode, NULL; numbers in text columns stay quoted.
        let sql = build(
            Engine::Postgres,
            vec![Change::Update {
                row: 1,
                values: vec![set("note", text("42")), set("data", NewValue::Null)],
            }],
        )
        .unwrap();
        assert_eq!(
            sql[0],
            r#"UPDATE "public"."my ""t""" SET "note" = '42', "data" = NULL WHERE "id" = 2"#
        );
        let sql = build(
            Engine::Postgres,
            vec![Change::Insert {
                values: vec![set("note", text("")), set("id", text("1e3"))],
            }],
        )
        .unwrap();
        assert_eq!(
            sql[0],
            r#"INSERT INTO "public"."my ""t""" ("note", "id") VALUES ('', 1e3)"#
        );
        let sql = build(
            Engine::Sqlite,
            vec![Change::Insert {
                values: vec![set("note", text("ünï ✓"))],
            }],
        )
        .unwrap();
        assert_eq!(
            sql[0],
            r#"INSERT INTO "public"."my ""t""" ("note") VALUES ('ünï ✓')"#
        );
    }

    #[test]
    fn defaults_per_engine() {
        let changes = || {
            vec![
                Change::Update {
                    row: 0,
                    values: vec![set("note", NewValue::Default)],
                },
                Change::Insert {
                    values: vec![set("note", NewValue::Default)],
                },
            ]
        };
        assert_eq!(
            build(Engine::Postgres, changes()).unwrap(),
            [
                r#"UPDATE "public"."my ""t""" SET "note" = DEFAULT WHERE "id" = 1"#,
                r#"INSERT INTO "public"."my ""t""" DEFAULT VALUES"#,
            ]
        );
        assert_eq!(
            build(Engine::Sqlite, changes()).unwrap()[0],
            r#"UPDATE "public"."my ""t""" SET "note" = ('none') WHERE "id" = 1"#
        );
    }

    #[test]
    fn copies_original_values_whole() {
        let sql = build(
            Engine::Postgres,
            vec![Change::Insert {
                values: vec![
                    set("note", NewValue::Original { row: 0 }),
                    set("data", NewValue::Original { row: 0 }),
                ],
            }],
        )
        .unwrap();
        assert_eq!(
            sql[0],
            r#"INSERT INTO "public"."my ""t""" ("note", "data") VALUES ('it''s', decode('dead', 'hex'))"#
        );
    }

    #[test]
    fn matches_composite_keys_and_rowids() {
        let page = page();
        let uploads = HashMap::new();
        let source = PageSource {
            page: &page,
            rowids: &[Value::Number("10".into()), Value::Number("11".into())],
            uploads: &uploads,
        };

        let mut composite = batch(Engine::Postgres, vec![Change::Delete { row: 0 }]);
        composite.identity = RowIdentity::Key {
            columns: vec!["id".into(), "note".into()],
            index: Some("u".into()),
        };
        assert_eq!(
            statements(Engine::Postgres, &composite, &source).unwrap()[0].sql,
            r#"DELETE FROM "public"."my ""t""" WHERE "id" = 1 AND "note" = 'it''s'"#
        );

        let mut rowid = batch(Engine::Sqlite, vec![Change::Delete { row: 1 }]);
        rowid.identity = RowIdentity::Rowid {
            rowid: "_rowid_".into(),
        };
        assert_eq!(
            statements(Engine::Sqlite, &rowid, &source).unwrap()[0].sql,
            r#"DELETE FROM "public"."my ""t""" WHERE _rowid_ = 11"#
        );
    }

    #[test]
    fn refuses_what_cant_be_written() {
        assert!(
            build(
                Engine::Postgres,
                vec![Change::Update {
                    row: 0,
                    values: vec![set("total", text("1"))],
                }],
            )
            .is_err()
        );
        assert!(
            build(
                Engine::Postgres,
                vec![Change::Update {
                    row: 0,
                    values: vec![set("missing", text("1"))],
                }],
            )
            .is_err()
        );
        assert!(
            build(
                Engine::Postgres,
                vec![Change::Update {
                    row: 0,
                    values: vec![],
                }],
            )
            .is_err()
        );
        assert!(build(Engine::Postgres, vec![Change::Delete { row: 7 }]).is_err());
        assert!(
            build(
                Engine::Postgres,
                vec![Change::Insert {
                    values: vec![set(
                        "data",
                        NewValue::File {
                            token: "gone".into()
                        }
                    )],
                }],
            )
            .is_err()
        );
    }

    #[test]
    fn recognizes_plain_numbers() {
        for n in ["0", "-12", "3.25", "1e3", "2.5E-4", "10."] {
            assert!(plain_number(n), "{n}");
        }
        for n in ["", "-", ".5", "1e", "NaN", "0x10", "1 ", "1,5"] {
            assert!(!plain_number(n), "{n}");
        }
        assert!(pg_numeric("numeric(10,2)"));
        assert!(!pg_numeric("integer[]"));
        assert!(sqlite_numeric("BOOLEAN"));
        assert!(!sqlite_numeric("VARCHAR(10)"));
        assert!(!sqlite_numeric(""));
    }
}
