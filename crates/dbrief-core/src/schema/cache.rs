//! The local schema cache in the app database, and table layouts for the data grid. Rows go away with
//! their connection (foreign key cascade).

use serde::Serialize;
use sqlx::SqlitePool;
use uuid::Uuid;

use super::{ObjectKind, SchemaColumn, SchemaObject, Snapshot};

#[derive(Clone, Debug)]
pub struct SchemaCache {
    pool: SqlitePool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "kebab-case")]
pub enum SearchKind {
    Table,
    Column,
}

/// A table (or view) or column found by search. `object_kind` is the kind of the table it is or
/// belongs to; `column` is set for columns.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct SearchHit {
    pub kind: SearchKind,
    pub connection_id: Uuid,
    pub schema: String,
    pub table: String,
    pub object_kind: ObjectKind,
    pub column: Option<String>,
    pub type_name: Option<String>,
    pub score: i32,
}

/// Escapes `%`, `_` and `\` for a `LIKE … ESCAPE '\'` pattern.
fn escape_like(text: &str) -> String {
    text.replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
}

/// `%a%b%c%`: rows whose text holds the query's characters in order, for fuzzy matching.
fn subsequence_pattern(query: &str) -> String {
    let mut pattern = String::from("%");
    for c in query.chars() {
        pattern.push_str(&escape_like(&c.to_string()));
        pattern.push('%');
    }
    pattern
}

/// How well `query` matches `text`, case-insensitively: `None` unless every query character appears in
/// order. Exact matches score highest, then prefixes, then matches at word starts (after `_`, `.`,
/// space or a lowercase-to-uppercase change) and runs of consecutive characters. Shorter texts win
/// ties. The frontend scores scripts and connections the same way (`src/lib/search.ts`).
pub fn fuzzy_score(query: &str, text: &str) -> Option<i32> {
    if query.is_empty() {
        return Some(0);
    }
    let q: Vec<char> = query.to_lowercase().chars().collect();
    let original: Vec<char> = text.chars().collect();
    let t: Vec<char> = text.to_lowercase().chars().collect();
    if t.len() != original.len() {
        // Lowercasing changed the length (rare letters); fall back to a plain contains check.
        return text
            .to_lowercase()
            .contains(&query.to_lowercase())
            .then_some(1);
    }

    if q == t {
        return Some(i32::MAX / 2);
    }

    let mut score = 0;
    let mut qi = 0;
    let mut previous: Option<usize> = None;
    for (ti, &c) in t.iter().enumerate() {
        if qi == q.len() {
            break;
        }
        if c != q[qi] {
            continue;
        }
        let word_start = ti == 0
            || matches!(t[ti - 1], '_' | '.' | ' ' | '-' | '/')
            || (original[ti - 1].is_lowercase() && original[ti].is_uppercase());
        score += 1;
        if word_start {
            score += 8;
        }
        if previous == Some(ti.wrapping_sub(1)) {
            score += 5;
        }
        previous = Some(ti);
        qi += 1;
    }
    if qi < q.len() {
        return None;
    }

    if t.starts_with(&q[..]) {
        score += 100;
    }
    Some(score * 10 - t.len().min(100) as i32)
}

/// Splits `schema.table` or `table.column` queries on the last dot.
fn split_dotted(query: &str) -> (Option<&str>, &str) {
    match query.rsplit_once('.') {
        Some((left, right)) => (Some(left), right),
        None => (None, query),
    }
}

impl SchemaCache {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }

    /// Replaces a connection's cached schema with `snapshot`, all at once.
    pub async fn replace(
        &self,
        connection_id: Uuid,
        snapshot: &Snapshot,
    ) -> Result<(), sqlx::Error> {
        let id = connection_id.to_string();
        let mut tx = self.pool.begin().await?;

        sqlx::query!(
            r#"
            DELETE FROM
                schema_objects
            WHERE
                connection_id = ?
            "#,
            id
        )
        .execute(&mut *tx)
        .await?;
        sqlx::query!(
            r#"
            DELETE FROM
                schema_columns
            WHERE
                connection_id = ?
            "#,
            id
        )
        .execute(&mut *tx)
        .await?;

        for o in &snapshot.objects {
            let kind = o.kind.as_str();
            sqlx::query!(
                r#"
                INSERT INTO
                    schema_objects (
                        connection_id,
                        schema,
                        name,
                        kind,
                        parent,
                        detail,
                        estimated_rows,
                        size_bytes
                    )
                VALUES
                    (?, ?, ?, ?, ?, ?, ?, ?)
                "#,
                id,
                o.schema,
                o.name,
                kind,
                o.parent,
                o.detail,
                o.estimated_rows,
                o.size_bytes
            )
            .execute(&mut *tx)
            .await?;
        }

        for c in &snapshot.columns {
            sqlx::query!(
                r#"
                INSERT OR REPLACE INTO
                    schema_columns (
                        connection_id,
                        schema,
                        table_name,
                        ordinal,
                        name,
                        type_name,
                        nullable,
                        default_value,
                        pk_ordinal
                    )
                VALUES
                    (?, ?, ?, ?, ?, ?, ?, ?, ?)
                "#,
                id,
                c.schema,
                c.table_name,
                c.ordinal,
                c.name,
                c.type_name,
                c.nullable,
                c.default_value,
                c.pk_ordinal
            )
            .execute(&mut *tx)
            .await?;
        }

        sqlx::query!(
            r#"
            UPDATE
                connections
            SET
                schema_refreshed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
            WHERE
                id = ?
            "#,
            id
        )
        .execute(&mut *tx)
        .await?;

        tx.commit().await
    }

    /// When the connection's schema was last loaded; `None` if never.
    pub async fn refreshed_at(&self, connection_id: Uuid) -> Result<Option<String>, sqlx::Error> {
        let id = connection_id.to_string();
        let row = sqlx::query!(
            r#"
            SELECT
                schema_refreshed_at
            FROM
                connections
            WHERE
                id = ?
            "#,
            id
        )
        .fetch_optional(&self.pool)
        .await?;
        Ok(row.and_then(|r| r.schema_refreshed_at))
    }

    /// Every cached object of a connection, ordered by schema, kind and name.
    pub async fn objects(&self, connection_id: Uuid) -> Result<Vec<SchemaObject>, sqlx::Error> {
        let id = connection_id.to_string();
        let rows = sqlx::query!(
            r#"
            SELECT
                schema,
                name,
                kind,
                parent,
                detail,
                estimated_rows,
                size_bytes
            FROM
                schema_objects
            WHERE
                connection_id = ?
            ORDER BY
                schema,
                name,
                detail
            "#,
            id
        )
        .fetch_all(&self.pool)
        .await?;

        Ok(rows
            .into_iter()
            .filter_map(|r| {
                Some(SchemaObject {
                    kind: ObjectKind::parse(&r.kind)?,
                    schema: r.schema,
                    name: r.name,
                    parent: r.parent,
                    detail: r.detail,
                    estimated_rows: r.estimated_rows,
                    size_bytes: r.size_bytes,
                })
            })
            .collect())
    }

    /// Columns of one table or view, in order.
    pub async fn columns(
        &self,
        connection_id: Uuid,
        schema: &str,
        table: &str,
    ) -> Result<Vec<SchemaColumn>, sqlx::Error> {
        let id = connection_id.to_string();
        let rows = sqlx::query!(
            r#"
            SELECT
                schema,
                table_name,
                ordinal AS "ordinal: u32",
                name,
                type_name,
                nullable AS "nullable: bool",
                default_value,
                pk_ordinal AS "pk_ordinal: u32"
            FROM
                schema_columns
            WHERE
                connection_id = ?
                AND schema = ?
                AND table_name = ?
            ORDER BY
                ordinal
            "#,
            id,
            schema,
            table
        )
        .fetch_all(&self.pool)
        .await?;

        Ok(rows
            .into_iter()
            .map(|r| SchemaColumn {
                schema: r.schema,
                table_name: r.table_name,
                ordinal: r.ordinal,
                name: r.name,
                type_name: r.type_name,
                nullable: r.nullable,
                default_value: r.default_value,
                pk_ordinal: r.pk_ordinal,
            })
            .collect())
    }

    /// Column names of every table and view of a connection, for autocomplete: `(schema, table,
    /// column)` in table and column order.
    pub async fn column_names(
        &self,
        connection_id: Uuid,
    ) -> Result<Vec<(String, String, String)>, sqlx::Error> {
        let id = connection_id.to_string();
        let rows = sqlx::query!(
            r#"
            SELECT
                schema,
                table_name,
                name
            FROM
                schema_columns
            WHERE
                connection_id = ?
            ORDER BY
                schema,
                table_name,
                ordinal
            "#,
            id
        )
        .fetch_all(&self.pool)
        .await?;
        Ok(rows
            .into_iter()
            .map(|r| (r.schema, r.table_name, r.name))
            .collect())
    }

    /// Tables, views and columns of every connection that fuzzy-match `query`, best first, at most
    /// `limit` of each kind. `schema.table` and `table.column` narrow by the part before the dot.
    pub async fn search(&self, query: &str, limit: usize) -> Result<Vec<SearchHit>, sqlx::Error> {
        let query = query.trim();
        if query.is_empty() {
            return Ok(Vec::new());
        }
        let (prefix, name) = split_dotted(query);
        let pattern = subsequence_pattern(name);

        let tables = sqlx::query!(
            r#"
            SELECT
                connection_id,
                schema,
                name,
                kind
            FROM
                schema_objects
            WHERE
                kind IN ('table', 'view', 'materialized-view')
                AND name LIKE ? ESCAPE '\'
            "#,
            pattern
        )
        .fetch_all(&self.pool)
        .await?;

        let mut table_hits: Vec<SearchHit> = tables
            .into_iter()
            .filter_map(|r| {
                let mut score = fuzzy_score(name, &r.name)?;
                if let Some(prefix) = prefix {
                    score += fuzzy_score(prefix, &r.schema)?;
                }
                Some(SearchHit {
                    kind: SearchKind::Table,
                    connection_id: Uuid::parse_str(&r.connection_id).ok()?,
                    schema: r.schema,
                    table: r.name,
                    object_kind: ObjectKind::parse(&r.kind)?,
                    column: None,
                    type_name: None,
                    score,
                })
            })
            .collect();
        table_hits.sort_by(|a, b| b.score.cmp(&a.score).then(a.table.cmp(&b.table)));
        table_hits.truncate(limit);

        let columns = sqlx::query!(
            r#"
            SELECT
                c.connection_id,
                c.schema,
                c.table_name,
                c.name,
                c.type_name,
                o.kind
            FROM
                schema_columns c
                JOIN schema_objects o ON o.connection_id = c.connection_id
                AND o.schema = c.schema
                AND o.name = c.table_name
                AND o.kind IN ('table', 'view', 'materialized-view')
            WHERE
                c.name LIKE ? ESCAPE '\'
            "#,
            pattern
        )
        .fetch_all(&self.pool)
        .await?;

        let mut column_hits: Vec<SearchHit> = columns
            .into_iter()
            .filter_map(|r| {
                let mut score = fuzzy_score(name, &r.name)?;
                if let Some(prefix) = prefix {
                    score += fuzzy_score(prefix, &r.table_name)?;
                }
                Some(SearchHit {
                    kind: SearchKind::Column,
                    connection_id: Uuid::parse_str(&r.connection_id).ok()?,
                    schema: r.schema,
                    table: r.table_name,
                    object_kind: ObjectKind::parse(&r.kind)?,
                    column: Some(r.name),
                    type_name: Some(r.type_name),
                    score,
                })
            })
            .collect();
        column_hits.sort_by(|a, b| {
            b.score
                .cmp(&a.score)
                .then(a.column.cmp(&b.column))
                .then(a.table.cmp(&b.table))
        });
        column_hits.truncate(limit);

        table_hits.extend(column_hits);
        Ok(table_hits)
    }

    /// The saved grid layout (JSON owned by the frontend) of a table.
    pub async fn layout(
        &self,
        connection_id: Uuid,
        schema: &str,
        table: &str,
    ) -> Result<Option<String>, sqlx::Error> {
        let id = connection_id.to_string();
        let row = sqlx::query!(
            r#"
            SELECT
                layout
            FROM
                table_layouts
            WHERE
                connection_id = ?
                AND schema = ?
                AND table_name = ?
            "#,
            id,
            schema,
            table
        )
        .fetch_optional(&self.pool)
        .await?;
        Ok(row.map(|r| r.layout))
    }

    pub async fn set_layout(
        &self,
        connection_id: Uuid,
        schema: &str,
        table: &str,
        layout: &str,
    ) -> Result<(), sqlx::Error> {
        let id = connection_id.to_string();
        sqlx::query!(
            r#"
            INSERT INTO
                table_layouts (connection_id, schema, table_name, layout)
            VALUES
                (?, ?, ?, ?)
            ON CONFLICT (connection_id, schema, table_name) DO UPDATE
            SET
                layout = excluded.layout
            "#,
            id,
            schema,
            table,
            layout
        )
        .execute(&self.pool)
        .await?;
        Ok(())
    }
}
