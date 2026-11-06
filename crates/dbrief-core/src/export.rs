//! Exports a statement's result to a file as CSV, JSON or SQL INSERT statements. Rows are written as
//! they arrive, so large results never sit in memory.

use std::fs::File;
use std::io::{BufWriter, Write};
use std::path::Path;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};

use crate::query::{Column, ResultSink, Row};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "kebab-case")]
pub enum ExportFormat {
    Csv,
    Json,
    Sql,
}

/// Type names whose text is a plain number, written unquoted in JSON and SQL.
fn is_number(type_name: &str) -> bool {
    let t = type_name.to_ascii_lowercase();
    [
        "int", "smallint", "bigint", "real", "float", "double", "numeric", "decimal", "oid",
    ]
    .iter()
    .any(|p| t.starts_with(p))
}

fn is_bool(type_name: &str) -> bool {
    matches!(type_name.to_ascii_lowercase().as_str(), "bool" | "boolean")
}

fn is_json(type_name: &str) -> bool {
    matches!(type_name.to_ascii_lowercase().as_str(), "json" | "jsonb")
}

fn csv_field(value: &str) -> String {
    if value.contains([',', '"', '\n', '\r']) {
        format!("\"{}\"", value.replace('"', "\"\""))
    } else {
        value.to_owned()
    }
}

fn sql_literal(value: Option<&str>, type_name: &str) -> String {
    match value {
        None => "NULL".to_owned(),
        Some(v) if is_number(type_name) && v.parse::<f64>().is_ok() => v.to_owned(),
        Some(v) => format!("'{}'", v.replace('\'', "''")),
    }
}

fn json_value(value: Option<&str>, type_name: &str) -> serde_json::Value {
    let Some(v) = value else {
        return serde_json::Value::Null;
    };
    if is_number(type_name)
        && let Ok(n) = v.parse::<serde_json::Number>()
    {
        return serde_json::Value::Number(n);
    }
    if is_bool(type_name) {
        match v {
            "t" | "true" | "1" => return serde_json::Value::Bool(true),
            "f" | "false" | "0" => return serde_json::Value::Bool(false),
            _ => {}
        }
    }
    if is_json(type_name)
        && let Ok(parsed) = serde_json::from_str(v)
    {
        return parsed;
    }
    serde_json::Value::String(v.to_owned())
}

/// A double-quoted SQL identifier.
fn quote_ident(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

/// Writes rows to a file in one format. `table` names the target of SQL INSERT statements.
pub struct ExportWriter {
    out: BufWriter<File>,
    format: ExportFormat,
    table: String,
    columns: Vec<Column>,
    rows: u64,
    error: Option<std::io::Error>,
}

impl ExportWriter {
    pub fn create(path: &Path, format: ExportFormat, table: &str) -> std::io::Result<Self> {
        Ok(Self {
            out: BufWriter::new(File::create(path)?),
            format,
            table: table.to_owned(),
            columns: Vec::new(),
            rows: 0,
            error: None,
        })
    }

    fn write_header(&mut self) -> std::io::Result<()> {
        match self.format {
            ExportFormat::Csv => {
                let header: Vec<String> = self.columns.iter().map(|c| csv_field(&c.name)).collect();
                writeln!(self.out, "{}", header.join(","))
            }
            ExportFormat::Json => write!(self.out, "["),
            ExportFormat::Sql => Ok(()),
        }
    }

    fn write_row(&mut self, row: &Row) -> std::io::Result<()> {
        match self.format {
            ExportFormat::Csv => {
                let fields: Vec<String> = row
                    .iter()
                    .map(|v| v.as_deref().map(csv_field).unwrap_or_default())
                    .collect();
                writeln!(self.out, "{}", fields.join(","))
            }
            ExportFormat::Json => {
                let object: serde_json::Map<String, serde_json::Value> = self
                    .columns
                    .iter()
                    .zip(row)
                    .map(|(c, v)| (c.name.clone(), json_value(v.as_deref(), &c.type_name)))
                    .collect();
                let separator = if self.rows == 0 { "\n  " } else { ",\n  " };
                write!(self.out, "{separator}{}", serde_json::Value::Object(object))
            }
            ExportFormat::Sql => {
                let names: Vec<String> =
                    self.columns.iter().map(|c| quote_ident(&c.name)).collect();
                let values: Vec<String> = self
                    .columns
                    .iter()
                    .zip(row)
                    .map(|(c, v)| sql_literal(v.as_deref(), &c.type_name))
                    .collect();
                writeln!(
                    self.out,
                    "INSERT INTO {} ({}) VALUES ({});",
                    quote_ident(&self.table),
                    names.join(", "),
                    values.join(", ")
                )
            }
        }
    }

    /// Finishes the file and returns the number of rows written.
    pub fn finish(mut self) -> std::io::Result<u64> {
        if let Some(e) = self.error.take() {
            return Err(e);
        }
        if self.format == ExportFormat::Json {
            writeln!(self.out, "{}]", if self.rows == 0 { "" } else { "\n" })?;
        }
        self.out.flush()?;
        Ok(self.rows)
    }
}

#[async_trait]
impl ResultSink for ExportWriter {
    async fn columns(&mut self, columns: Vec<Column>) {
        self.columns = columns;
        if let Err(e) = self.write_header() {
            self.error = Some(e);
        }
    }

    async fn page(&mut self, rows: Vec<Row>, _more: bool) -> bool {
        for row in &rows {
            if let Err(e) = self.write_row(row) {
                self.error = Some(e);
                return false;
            }
            self.rows += 1;
        }
        // Keep reading until every row is written.
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn columns() -> Vec<Column> {
        [
            ("id", "INT4"),
            ("name", "TEXT"),
            ("ok", "BOOL"),
            ("data", "JSONB"),
        ]
        .iter()
        .map(|(n, t)| Column {
            name: (*n).into(),
            type_name: (*t).into(),
        })
        .collect()
    }

    fn rows() -> Vec<Row> {
        vec![
            vec![
                Some("1".into()),
                Some("it's, \"quoted\"".into()),
                Some("t".into()),
                Some(r#"{"a":1}"#.into()),
            ],
            vec![Some("2".into()), None, Some("f".into()), None],
        ]
    }

    async fn export(format: ExportFormat) -> (String, u64) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("out");
        let mut writer = ExportWriter::create(&path, format, "my table").unwrap();
        writer.columns(columns()).await;
        writer.page(rows(), false).await;
        let count = writer.finish().unwrap();
        (std::fs::read_to_string(&path).unwrap(), count)
    }

    #[tokio::test]
    async fn writes_csv() {
        let (text, count) = export(ExportFormat::Csv).await;
        assert_eq!(count, 2);
        assert_eq!(
            text,
            "id,name,ok,data\n1,\"it's, \"\"quoted\"\"\",t,\"{\"\"a\"\":1}\"\n2,,f,\n"
        );
    }

    #[tokio::test]
    async fn writes_json_with_types() {
        let (text, _) = export(ExportFormat::Json).await;
        let parsed: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(
            parsed,
            serde_json::json!([
                {"id": 1, "name": "it's, \"quoted\"", "ok": true, "data": {"a": 1}},
                {"id": 2, "name": null, "ok": false, "data": null}
            ])
        );
    }

    #[tokio::test]
    async fn writes_sql_inserts() {
        let (text, _) = export(ExportFormat::Sql).await;
        let lines: Vec<&str> = text.lines().collect();
        assert_eq!(
            lines[0],
            r#"INSERT INTO "my table" ("id", "name", "ok", "data") VALUES (1, 'it''s, "quoted"', 't', '{"a":1}');"#
        );
        assert_eq!(
            lines[1],
            r#"INSERT INTO "my table" ("id", "name", "ok", "data") VALUES (2, NULL, 'f', NULL);"#
        );
    }

    #[tokio::test]
    async fn empty_json_is_an_empty_array() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("out.json");
        let mut writer = ExportWriter::create(&path, ExportFormat::Json, "t").unwrap();
        writer.columns(columns()).await;
        writer.finish().unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "[]\n");
    }
}
