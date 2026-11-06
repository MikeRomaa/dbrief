//! The app's own SQLite database (`dbrief.db`) in the app data directory.

use std::path::Path;

use sqlx::SqlitePool;
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions};

/// File name of the app database inside the app data directory.
pub const DB_FILE: &str = "dbrief.db";

static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("./migrations");

#[derive(Debug, thiserror::Error)]
pub enum StorageError {
    #[error("could not create app data directory: {0}")]
    Io(#[from] std::io::Error),
    #[error("database error: {0}")]
    Db(#[from] sqlx::Error),
    #[error("migration failed: {0}")]
    Migrate(#[from] sqlx::migrate::MigrateError),
}

#[derive(Clone, Debug)]
pub struct Storage {
    pool: SqlitePool,
}

impl Storage {
    /// Opens (or creates) `dbrief.db` in `data_dir` and applies pending migrations.
    pub async fn open(data_dir: &Path) -> Result<Self, StorageError> {
        std::fs::create_dir_all(data_dir)?;
        let options = SqliteConnectOptions::new()
            .filename(data_dir.join(DB_FILE))
            .create_if_missing(true)
            .journal_mode(SqliteJournalMode::Wal)
            .foreign_keys(true);
        let pool = SqlitePoolOptions::new()
            .max_connections(4)
            .connect_with(options)
            .await?;
        MIGRATOR.run(&pool).await?;
        Ok(Self { pool })
    }

    pub fn pool(&self) -> &SqlitePool {
        &self.pool
    }

    /// Reads a UI state value by key.
    pub async fn get_ui_state(&self, key: &str) -> Result<Option<String>, StorageError> {
        let row = sqlx::query!("SELECT value FROM ui_state WHERE key = ?", key)
            .fetch_optional(&self.pool)
            .await?;
        Ok(row.map(|r| r.value))
    }

    /// Inserts or replaces a UI state value.
    pub async fn set_ui_state(&self, key: &str, value: &str) -> Result<(), StorageError> {
        sqlx::query!(
            "INSERT INTO ui_state (key, value) VALUES (?, ?)
             ON CONFLICT(key) DO UPDATE SET
               value = excluded.value,
               updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')",
            key,
            value
        )
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn close(&self) {
        self.pool.close().await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn creates_database_and_applies_migrations() {
        let dir = tempfile::tempdir().unwrap();
        let data_dir = dir.path().join("nested").join("data");
        let storage = Storage::open(&data_dir).await.unwrap();
        assert!(data_dir.join(DB_FILE).exists());

        let applied: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM _sqlx_migrations")
            .fetch_one(storage.pool())
            .await
            .unwrap();
        assert_eq!(applied, MIGRATOR.iter().count() as i64);
        storage.close().await;
    }

    #[tokio::test]
    async fn ui_state_round_trip_and_overwrite() {
        let dir = tempfile::tempdir().unwrap();
        let storage = Storage::open(dir.path()).await.unwrap();

        assert_eq!(storage.get_ui_state("layout").await.unwrap(), None);
        storage.set_ui_state("layout", "{\"a\":1}").await.unwrap();
        assert_eq!(
            storage.get_ui_state("layout").await.unwrap().as_deref(),
            Some("{\"a\":1}")
        );
        storage.set_ui_state("layout", "{\"a\":2}").await.unwrap();
        assert_eq!(
            storage.get_ui_state("layout").await.unwrap().as_deref(),
            Some("{\"a\":2}")
        );
        storage.close().await;
    }

    #[tokio::test]
    async fn reopening_keeps_data() {
        let dir = tempfile::tempdir().unwrap();
        let storage = Storage::open(dir.path()).await.unwrap();
        storage.set_ui_state("k", "v").await.unwrap();
        storage.close().await;

        let reopened = Storage::open(dir.path()).await.unwrap();
        assert_eq!(
            reopened.get_ui_state("k").await.unwrap().as_deref(),
            Some("v")
        );
        reopened.close().await;
    }
}
