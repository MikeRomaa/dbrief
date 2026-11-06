//! The table tab's data grid: the page query built from a table and the user's WHERE and ORDER BY,
//! display cells, and what the grid does with the full values of the page the session keeps (the
//! inspector, find, copy, saving a value to a file).

use std::time::Instant;

use serde::{Deserialize, Serialize};
use sqlparser::dialect::{Dialect, PostgreSqlDialect, SQLiteDialect};
use sqlparser::tokenizer::{Token, Tokenizer};

use crate::classify::{StatementKind, classify};
use crate::connections::Engine;
use crate::export::{ExportFormat, ExportWriter};
use crate::query::{Column, Row, Value, Values};
use crate::schema::{ObjectKind, SchemaColumn, qualified, quote_ident};
use crate::session::{Session, SessionError};

/// Characters of text a grid cell receives; the inspector reads the rest.
pub const CELL_TEXT_LIMIT: usize = 1000;

/// Bytes of a binary value shown in the inspector's hex preview.
const HEX_PREVIEW: usize = 4096;

/// Binary values up to this size are sent to the inspector for an image preview.
const IMAGE_PREVIEW_LIMIT: usize = 8 * 1024 * 1024;

/// A table or view with the user's filter (`WHERE` text) and sort (`ORDER BY` text).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct TableQuery {
    pub schema: String,
    pub name: String,
    pub filter: Option<String>,
    pub order: Option<String>,
}

impl TableQuery {
    fn filter(&self) -> Option<&str> {
        self.filter
            .as_deref()
            .map(str::trim)
            .filter(|f| !f.is_empty())
    }

    fn order(&self) -> Option<&str> {
        self.order
            .as_deref()
            .map(str::trim)
            .filter(|o| !o.is_empty())
    }

    /// `FROM … [WHERE …]`. User text goes on its own lines, so a trailing `--` comment can't swallow
    /// the rest of the statement.
    fn source_and_filter(&self) -> String {
        let mut sql = format!("FROM\n    {}", qualified(&self.schema, &self.name));
        if let Some(filter) = self.filter() {
            sql.push_str(&format!("\nWHERE\n    (\n{filter}\n    )"));
        }
        sql
    }

    fn order_by(&self, default_order: Option<&str>) -> String {
        match self.order().or(default_order) {
            Some(order) => format!("\nORDER BY\n{order}\n"),
            None => String::new(),
        }
    }

    /// The page query: `SELECT *` with the filter, the sort (or `default_order`), and paging.
    pub fn page_sql(
        &self,
        engine: Engine,
        default_order: Option<&str>,
        limit: u32,
        offset: u64,
    ) -> Result<String, SessionError> {
        let sql = format!(
            "SELECT\n    *\n{}{}\nLIMIT\n    {limit}\nOFFSET\n    {offset}",
            self.source_and_filter(),
            self.order_by(default_order)
        );
        check_single_select(&sql, engine)?;
        Ok(sql)
    }

    /// Every row with the filter and sort, for exporting.
    pub fn export_sql(
        &self,
        engine: Engine,
        default_order: Option<&str>,
    ) -> Result<String, SessionError> {
        let sql = format!(
            "SELECT\n    *\n{}{}",
            self.source_and_filter(),
            self.order_by(default_order)
        );
        check_single_select(&sql, engine)?;
        Ok(sql)
    }

    /// The number of rows matching the filter.
    pub fn count_sql(&self, engine: Engine) -> Result<String, SessionError> {
        let sql = format!(
            "SELECT\n    count(*) AS count\n{}",
            self.source_and_filter()
        );
        check_single_select(&sql, engine)?;
        Ok(sql)
    }

    /// The table as an INSERT target, `"schema"."name"`.
    pub fn target(&self) -> String {
        qualified(&self.schema, &self.name)
    }
}

/// The filter and sort are the user's own text inside a statement the app builds, so the whole
/// statement must stay one read. Over the simple query protocol a `;` would start a second
/// statement, and an unterminated string or comment would swallow the paging.
fn check_single_select(sql: &str, engine: Engine) -> Result<(), SessionError> {
    let dialect: &dyn Dialect = match engine {
        Engine::Postgres => &PostgreSqlDialect {},
        Engine::Sqlite => &SQLiteDialect {},
    };
    let tokens = Tokenizer::new(dialect, sql).tokenize().map_err(|e| {
        SessionError::Invalid(format!("the filter or sort can't be read: {}", e.message))
    })?;
    if tokens.iter().any(|t| matches!(t, Token::SemiColon)) {
        return Err(SessionError::Invalid(
            "the filter and sort can't contain ';'".into(),
        ));
    }

    // Anything the parser understands must be a read. SQL it can't parse goes to the database, which
    // reports the syntax error (and enforces RO on its own).
    if sqlparser::parser::Parser::parse_sql(dialect, sql).is_ok()
        && classify(sql, engine) != StatementKind::Read
    {
        return Err(SessionError::Invalid(
            "the filter and sort can only read data".into(),
        ));
    }
    Ok(())
}

/// The sort that keeps pages stable when the user chose none: the primary key, or SQLite's `rowid`
/// for a table without one. Views and PostgreSQL tables without a primary key get none.
pub fn default_order(engine: Engine, kind: ObjectKind, columns: &[SchemaColumn]) -> Option<String> {
    if kind != ObjectKind::Table {
        return None;
    }
    let mut key: Vec<&SchemaColumn> = columns.iter().filter(|c| c.pk_ordinal.is_some()).collect();
    key.sort_by_key(|c| c.pk_ordinal);
    if !key.is_empty() {
        return Some(
            key.iter()
                .map(|c| format!("    {}", quote_ident(&c.name)))
                .collect::<Vec<_>>()
                .join(",\n"),
        );
    }
    (engine == Engine::Sqlite).then(|| "    rowid".to_owned())
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "lowercase")]
pub enum ImageKind {
    Png,
    Jpeg,
}

impl ImageKind {
    fn detect(bytes: &[u8]) -> Option<Self> {
        if bytes.starts_with(&[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]) {
            Some(Self::Png)
        } else if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
            Some(Self::Jpeg)
        } else {
            None
        }
    }

    fn mime(self) -> &'static str {
        match self {
            Self::Png => "image/png",
            Self::Jpeg => "image/jpeg",
        }
    }
}

/// What a grid cell shows: text, text cut short at [`CELL_TEXT_LIMIT`] characters (`length` is the
/// whole value's), or a binary value's size. NULL is `null`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(untagged)]
pub enum Cell {
    Text(String),
    Cut {
        cut: String,
        length: u32,
    },
    Binary {
        binary: u32,
        image: Option<ImageKind>,
    },
}

impl Cell {
    pub fn of(value: &Value) -> Option<Self> {
        match value {
            Value::Null => None,
            Value::Text(text) => {
                let Some((cut_at, _)) = text.char_indices().nth(CELL_TEXT_LIMIT) else {
                    return Some(Self::Text(text.clone()));
                };
                Some(Self::Cut {
                    cut: text[..cut_at].to_owned(),
                    length: text.chars().count() as u32,
                })
            }
            Value::Bytes(bytes) => Some(Self::Binary {
                binary: bytes.len() as u32,
                image: ImageKind::detect(bytes),
            }),
        }
    }
}

/// One page of a table, as the grid shows it.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct GridPage {
    pub columns: Vec<Column>,
    pub cells: Vec<Vec<Option<Cell>>>,
    pub duration_ms: f64,
}

/// A value in full, for the inspector. `text` holds text values; binary values have their `size`, a
/// hex preview of the first bytes and, for PNG and JPEG up to a few MB, the image as a data URL.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct FullValue {
    pub null: bool,
    pub text: Option<String>,
    pub size: u32,
    pub hex: Option<String>,
    pub image: Option<String>,
}

impl FullValue {
    pub fn of(value: &Value) -> Self {
        match value {
            Value::Null => Self {
                null: true,
                ..Self::default()
            },
            Value::Text(text) => Self {
                text: Some(text.clone()),
                size: text.len() as u32,
                ..Self::default()
            },
            Value::Bytes(bytes) => Self {
                size: bytes.len() as u32,
                hex: Some(hex_dump(&bytes[..bytes.len().min(HEX_PREVIEW)])),
                image: ImageKind::detect(bytes)
                    .filter(|_| bytes.len() <= IMAGE_PREVIEW_LIMIT)
                    .map(|kind| format!("data:{};base64,{}", kind.mime(), base64(bytes))),
                ..Self::default()
            },
        }
    }
}

/// Rows of 16 bytes: offset, hex, and printable ASCII.
fn hex_dump(bytes: &[u8]) -> String {
    bytes
        .chunks(16)
        .enumerate()
        .map(|(i, chunk)| {
            let hex: Vec<String> = chunk.iter().map(|b| format!("{b:02x}")).collect();
            let ascii: String = chunk
                .iter()
                .map(|&b| {
                    if b.is_ascii_graphic() || b == b' ' {
                        b as char
                    } else {
                        '.'
                    }
                })
                .collect();
            format!("{:08x}  {:<47}  {ascii}", i * 16, hex.join(" "))
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn base64(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = (u32::from(chunk[0]) << 16)
            | (u32::from(*chunk.get(1).unwrap_or(&0)) << 8)
            | u32::from(*chunk.get(2).unwrap_or(&0));
        for i in 0..4 {
            if i <= chunk.len() {
                out.push(ALPHABET[(n >> (18 - 6 * i) & 63) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

/// A value as text for copying: binary as PostgreSQL's `\x…` hex.
fn copy_text(value: &Value) -> Option<String> {
    match value {
        Value::Null => None,
        Value::Text(text) => Some(text.clone()),
        Value::Bytes(bytes) => Some(format!(
            "\\x{}",
            bytes.iter().map(|b| format!("{b:02x}")).collect::<String>()
        )),
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "kebab-case")]
pub enum CopyFormat {
    Tsv,
    TsvWithHeaders,
    Insert,
    Json,
}

/// Copies `rows` × `columns` of the page (indexes into the page, in display order).
pub fn copy(
    page: &Values,
    rows: &[u32],
    columns: &[u32],
    format: CopyFormat,
    target: String,
) -> Result<String, SessionError> {
    let picked_columns: Vec<Column> = columns
        .iter()
        .filter_map(|&c| page.columns.get(c as usize).cloned())
        .collect();
    let picked_rows: Vec<Row> = rows
        .iter()
        .filter_map(|&r| page.rows.get(r as usize))
        .map(|row| {
            columns
                .iter()
                .map(|&c| row.get(c as usize).and_then(copy_text))
                .collect()
        })
        .collect();

    match format {
        CopyFormat::Tsv | CopyFormat::TsvWithHeaders => {
            let clean = |v: &str| v.replace(['\t', '\r', '\n'], " ");
            let mut lines = Vec::new();
            if format == CopyFormat::TsvWithHeaders {
                lines.push(
                    picked_columns
                        .iter()
                        .map(|c| clean(&c.name))
                        .collect::<Vec<_>>()
                        .join("\t"),
                );
            }
            for row in &picked_rows {
                lines.push(
                    row.iter()
                        .map(|v| v.as_deref().map(clean).unwrap_or_default())
                        .collect::<Vec<_>>()
                        .join("\t"),
                );
            }
            Ok(lines.join("\n"))
        }
        CopyFormat::Insert | CopyFormat::Json => {
            let format = if format == CopyFormat::Insert {
                ExportFormat::Sql
            } else {
                ExportFormat::Json
            };
            ExportWriter::to_text(format, target, picked_columns, &picked_rows)
                .map(|text| text.trim_end().to_owned())
                .map_err(|e| SessionError::Invalid(e.to_string()))
        }
    }
}

/// Cells of the page whose text contains `text`, ignoring case, as `[row, column]`.
pub fn find(page: &Values, text: &str) -> Vec<[u32; 2]> {
    let needle = text.to_lowercase();
    if needle.is_empty() {
        return Vec::new();
    }
    let mut found = Vec::new();
    for (r, row) in page.rows.iter().enumerate() {
        for (c, value) in row.iter().enumerate() {
            if let Value::Text(t) = value
                && t.to_lowercase().contains(&needle)
            {
                found.push([r as u32, c as u32]);
            }
        }
    }
    found
}

/// Writes a value to a file: binary values as their bytes, text as UTF-8.
pub fn save(value: &Value, path: &std::path::Path) -> std::io::Result<()> {
    match value {
        Value::Null => std::fs::write(path, b""),
        Value::Text(t) => std::fs::write(path, t.as_bytes()),
        Value::Bytes(b) => std::fs::write(path, b),
    }
}

impl Session {
    /// Runs a table page query, keeps the page's full values for the inspector, find and copy, and
    /// returns its display cells.
    pub async fn table_page(&mut self, sql: &str) -> Result<GridPage, SessionError> {
        let started = Instant::now();
        let values = self.fetch_values(sql).await?;
        let duration_ms = started.elapsed().as_secs_f64() * 1000.0;
        let page = GridPage {
            columns: values.columns.clone(),
            cells: values
                .rows
                .iter()
                .map(|row| row.iter().map(Cell::of).collect())
                .collect(),
            duration_ms,
        };
        self.page = Some(values);
        Ok(page)
    }

    /// The full values of the last table page.
    pub fn page(&self) -> Result<&Values, SessionError> {
        self.page
            .as_ref()
            .ok_or_else(|| SessionError::Invalid("no table page is loaded".into()))
    }

    /// One value of the last table page.
    pub fn page_value(&self, row: u32, column: u32) -> Result<&Value, SessionError> {
        self.page()?
            .rows
            .get(row as usize)
            .and_then(|r| r.get(column as usize))
            .ok_or_else(|| SessionError::Invalid("that cell is not on the loaded page".into()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn query(filter: Option<&str>, order: Option<&str>) -> TableQuery {
        TableQuery {
            schema: "public".into(),
            name: "my \"table\"".into(),
            filter: filter.map(Into::into),
            order: order.map(Into::into),
        }
    }

    #[test]
    fn builds_the_page_query() {
        let sql = query(Some("a > 1"), None)
            .page_sql(Engine::Postgres, Some("    \"id\""), 50, 100)
            .unwrap();
        assert!(
            sql.contains("FROM\n    \"public\".\"my \"\"table\"\"\""),
            "{sql}"
        );
        assert!(sql.contains("WHERE\n    (\na > 1\n    )"), "{sql}");
        assert!(sql.contains("ORDER BY\n    \"id\""), "{sql}");
        assert!(sql.ends_with("LIMIT\n    50\nOFFSET\n    100"), "{sql}");

        // The user's sort replaces the default one.
        let sql = query(None, Some("name DESC"))
            .page_sql(Engine::Sqlite, Some("    rowid"), 10, 0)
            .unwrap();
        assert!(sql.contains("ORDER BY\nname DESC"), "{sql}");
        assert!(!sql.contains("rowid"), "{sql}");
    }

    #[test]
    fn trailing_comments_cannot_swallow_the_paging() {
        let sql = query(Some("a = 1 -- note"), None)
            .page_sql(Engine::Postgres, None, 50, 0)
            .unwrap();
        assert!(sql.contains("-- note\n"), "{sql}");
        assert!(sql.contains("LIMIT"), "{sql}");
    }

    #[test]
    fn rejects_a_second_statement_or_unterminated_text() {
        for engine in [Engine::Postgres, Engine::Sqlite] {
            for filter in [
                "1 = 1; DROP TABLE users",
                "1 = 1); DELETE FROM users; SELECT (1",
                "name = 'open",
                "1 = 1 /* open",
            ] {
                assert!(
                    query(Some(filter), None)
                        .page_sql(engine, None, 50, 0)
                        .is_err(),
                    "{filter}"
                );
            }
            assert!(
                query(None, Some("1; DROP TABLE users"))
                    .count_sql(engine)
                    .is_ok(),
                "the count ignores the sort"
            );
            assert!(
                query(None, Some("1; DROP TABLE users"))
                    .export_sql(engine, None)
                    .is_err()
            );
        }

        // Semicolons inside strings and dollar quotes are fine.
        assert!(
            query(Some("note = 'a;b' OR note = $$c;d$$"), None)
                .page_sql(Engine::Postgres, None, 50, 0)
                .is_ok()
        );
    }

    #[test]
    fn default_order_per_table_kind() {
        let column = |name: &str, pk: Option<u32>| SchemaColumn {
            schema: "s".into(),
            table_name: "t".into(),
            ordinal: 1,
            name: name.into(),
            type_name: "int".into(),
            nullable: false,
            default_value: None,
            pk_ordinal: pk,
        };
        let keyed = [
            column("b", Some(2)),
            column("x", None),
            column("a", Some(1)),
        ];
        assert_eq!(
            default_order(Engine::Postgres, ObjectKind::Table, &keyed).as_deref(),
            Some("    \"a\",\n    \"b\"")
        );
        let plain = [column("x", None)];
        assert_eq!(
            default_order(Engine::Postgres, ObjectKind::Table, &plain),
            None
        );
        assert_eq!(
            default_order(Engine::Sqlite, ObjectKind::Table, &plain).as_deref(),
            Some("    rowid")
        );
        assert_eq!(
            default_order(Engine::Sqlite, ObjectKind::View, &keyed),
            None
        );
    }

    #[test]
    fn cells_cut_long_text_and_describe_binary() {
        assert_eq!(Cell::of(&Value::Null), None);
        assert_eq!(
            Cell::of(&Value::Text("hi".into())),
            Some(Cell::Text("hi".into()))
        );

        let long = "é".repeat(CELL_TEXT_LIMIT + 5);
        match Cell::of(&Value::Text(long)) {
            Some(Cell::Cut { cut, length }) => {
                assert_eq!(cut.chars().count(), CELL_TEXT_LIMIT);
                assert_eq!(length as usize, CELL_TEXT_LIMIT + 5);
            }
            other => panic!("{other:?}"),
        }

        let png = [0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, 0];
        assert_eq!(
            Cell::of(&Value::Bytes(png.to_vec())),
            Some(Cell::Binary {
                binary: 9,
                image: Some(ImageKind::Png)
            })
        );
        assert_eq!(
            Cell::of(&Value::Bytes(vec![0xff, 0xd8, 0xff, 0xe0])),
            Some(Cell::Binary {
                binary: 4,
                image: Some(ImageKind::Jpeg)
            })
        );
    }

    #[test]
    fn full_values_have_hex_and_images() {
        let value = FullValue::of(&Value::Bytes(b"\xff\xd8\xffAB".to_vec()));
        assert_eq!(value.size, 5);
        assert_eq!(
            value.hex,
            Some(format!("00000000  {:<47}  ...AB", "ff d8 ff 41 42"))
        );
        assert_eq!(
            value.image.as_deref(),
            Some("data:image/jpeg;base64,/9j/QUI=")
        );
        assert_eq!(base64(b"Ma"), "TWE=");
        assert_eq!(base64(b"M"), "TQ==");
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
            ],
            rows: vec![
                vec![Value::Text("1".into()), Value::Text("Hello\tthere".into())],
                vec![Value::Text("2".into()), Value::Null],
            ],
        }
    }

    #[test]
    fn copies_in_each_format() {
        let page = page();
        let target = "\"s\".\"t\"".to_owned();
        assert_eq!(
            copy(
                &page,
                &[0, 1],
                &[1, 0],
                CopyFormat::TsvWithHeaders,
                target.clone()
            )
            .unwrap(),
            "note\tid\nHello there\t1\n\t2"
        );
        assert_eq!(
            copy(&page, &[1], &[0, 1], CopyFormat::Insert, target.clone()).unwrap(),
            "INSERT INTO \"s\".\"t\" (\"id\", \"note\") VALUES (2, NULL);"
        );
        assert_eq!(
            copy(&page, &[0], &[0], CopyFormat::Json, target).unwrap(),
            "[\n  {\"id\":1}\n]"
        );
    }

    #[test]
    fn finds_text_ignoring_case() {
        assert_eq!(find(&page(), "HELLO"), vec![[0, 1]]);
        assert_eq!(find(&page(), "2"), vec![[1, 0]]);
        assert!(find(&page(), "").is_empty());
    }
}
