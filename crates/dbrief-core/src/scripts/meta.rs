//! Per-script settings in the app database: the bound connection, the schema, and the last value of
//! each query parameter. Keyed by path, so renames and moves made in the app carry them along.

use std::collections::BTreeMap;

use serde::Serialize;
use sqlx::SqlitePool;
use uuid::Uuid;

use super::ScriptsError;

/// Parameter values by placeholder key; `None` is SQL NULL.
pub type ParamValues = BTreeMap<String, Option<String>>;

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct ScriptMeta {
    pub connection_id: Option<Uuid>,
    pub schema: Option<String>,
    pub params: ParamValues,
}

#[derive(Clone, Debug)]
pub struct ScriptMetaRepo {
    pool: SqlitePool,
}

/// `LIKE` pattern for everything inside folder `path`, with `%`, `_` and `\` escaped.
fn inside(path: &str) -> String {
    let escaped = path
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_");
    format!("{escaped}/%")
}

impl ScriptMetaRepo {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }

    /// The settings of a script; defaults when it has none.
    pub async fn get(&self, path: &str) -> Result<ScriptMeta, ScriptsError> {
        let row = sqlx::query!(
            r#"
            SELECT
                connection_id,
                schema,
                params
            FROM
                scripts
            WHERE
                path = ?
            "#,
            path
        )
        .fetch_optional(&self.pool)
        .await?;

        let Some(row) = row else {
            return Ok(ScriptMeta::default());
        };
        Ok(ScriptMeta {
            connection_id: row
                .connection_id
                .as_deref()
                .and_then(|id| Uuid::parse_str(id).ok()),
            schema: row.schema,
            params: row
                .params
                .as_deref()
                .and_then(|p| serde_json::from_str(p).ok())
                .unwrap_or_default(),
        })
    }

    pub async fn set_connection(
        &self,
        path: &str,
        connection_id: Option<Uuid>,
    ) -> Result<(), ScriptsError> {
        let id = connection_id.map(|id| id.to_string());
        sqlx::query!(
            r#"
            INSERT INTO
                scripts (path, connection_id)
            VALUES
                (?, ?)
            ON CONFLICT (path) DO UPDATE
            SET
                connection_id = excluded.connection_id,
                updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
            "#,
            path,
            id
        )
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn set_schema(&self, path: &str, schema: Option<&str>) -> Result<(), ScriptsError> {
        sqlx::query!(
            r#"
            INSERT INTO
                scripts (path, schema)
            VALUES
                (?, ?)
            ON CONFLICT (path) DO UPDATE
            SET
                schema = excluded.schema,
                updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
            "#,
            path,
            schema
        )
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Remembers parameter values, merged into the ones already saved.
    pub async fn remember_params(
        &self,
        path: &str,
        values: &ParamValues,
    ) -> Result<(), ScriptsError> {
        let mut params = self.get(path).await?.params;
        params.extend(values.iter().map(|(k, v)| (k.clone(), v.clone())));
        let json =
            serde_json::to_string(&params).map_err(|e| ScriptsError::Invalid(e.to_string()))?;

        sqlx::query!(
            r#"
            INSERT INTO
                scripts (path, params)
            VALUES
                (?, ?)
            ON CONFLICT (path) DO UPDATE
            SET
                params = excluded.params,
                updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
            "#,
            path,
            json
        )
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Follows a rename or move of a script, or of a folder and everything in it.
    pub async fn moved(&self, from: &str, to: &str) -> Result<(), ScriptsError> {
        let pattern = inside(from);
        let skip = i64::try_from(from.len()).unwrap_or(i64::MAX) + 1;
        sqlx::query!(
            r#"
            UPDATE
                scripts
            SET
                path = ? || substr(path, ?)
            WHERE
                path = ?
                OR path LIKE ? ESCAPE '\'
            "#,
            to,
            skip,
            from,
            pattern
        )
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Forgets a deleted script, or everything in a deleted folder.
    pub async fn removed(&self, path: &str) -> Result<(), ScriptsError> {
        let pattern = inside(path);
        sqlx::query!(
            r#"
            DELETE FROM
                scripts
            WHERE
                path = ?
                OR path LIKE ? ESCAPE '\'
            "#,
            path,
            pattern
        )
        .execute(&self.pool)
        .await?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Storage;
    use crate::connections::{AccessLevel, ConnectionInput, ConnectionRepo, Engine, ItemRef};

    async fn repos() -> (tempfile::TempDir, ScriptMetaRepo, ConnectionRepo) {
        let dir = tempfile::tempdir().unwrap();
        let storage = Storage::open(dir.path()).await.unwrap();
        (
            dir,
            ScriptMetaRepo::new(storage.pool().clone()),
            ConnectionRepo::new(storage.pool().clone()),
        )
    }

    #[tokio::test]
    async fn stores_settings_per_script() {
        let (_dir, meta, connections) = repos().await;
        let mut input = ConnectionInput::new("db", Engine::Sqlite, AccessLevel::Rw);
        input.file_path = Some("/tmp/x.db".into());
        let connection = connections.create_connection(input).await.unwrap();

        assert_eq!(meta.get("a.sql").await.unwrap(), ScriptMeta::default());
        meta.set_connection("a.sql", Some(connection.id))
            .await
            .unwrap();
        meta.set_schema("a.sql", Some("app")).await.unwrap();
        meta.remember_params(
            "a.sql",
            &ParamValues::from([("id".into(), Some("7".into()))]),
        )
        .await
        .unwrap();
        meta.remember_params("a.sql", &ParamValues::from([("x".into(), None)]))
            .await
            .unwrap();

        let saved = meta.get("a.sql").await.unwrap();
        assert_eq!(saved.connection_id, Some(connection.id));
        assert_eq!(saved.schema.as_deref(), Some("app"));
        assert_eq!(
            saved.params,
            ParamValues::from([("id".into(), Some("7".into())), ("x".into(), None)])
        );

        // Removing the connection unbinds the script.
        connections
            .delete(ItemRef::Connection(connection.id))
            .await
            .unwrap();
        assert_eq!(meta.get("a.sql").await.unwrap().connection_id, None);
    }

    #[tokio::test]
    async fn follows_moves_and_deletes_of_folders() {
        let (_dir, meta, _) = repos().await;
        for path in [
            "billing/a.sql",
            "billing/old/b.sql",
            "billing_x/c.sql",
            "d.sql",
        ] {
            meta.set_schema(path, Some(path)).await.unwrap();
        }

        meta.moved("billing", "finance").await.unwrap();
        assert_eq!(
            meta.get("finance/a.sql").await.unwrap().schema.as_deref(),
            Some("billing/a.sql")
        );
        assert_eq!(
            meta.get("finance/old/b.sql")
                .await
                .unwrap()
                .schema
                .as_deref(),
            Some("billing/old/b.sql")
        );
        // A folder whose name only starts the same way is left alone (and `_` is not a wildcard).
        assert_eq!(
            meta.get("billing_x/c.sql").await.unwrap().schema.as_deref(),
            Some("billing_x/c.sql")
        );

        meta.moved("d.sql", "finance/d.sql").await.unwrap();
        assert!(meta.get("finance/d.sql").await.unwrap().schema.is_some());

        meta.removed("finance").await.unwrap();
        assert_eq!(
            meta.get("finance/a.sql").await.unwrap(),
            ScriptMeta::default()
        );
        assert!(meta.get("billing_x/c.sql").await.unwrap().schema.is_some());
    }
}
