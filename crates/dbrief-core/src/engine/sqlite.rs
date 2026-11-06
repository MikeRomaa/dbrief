//! SQLite via sqlx, and SQLite file URLs and paths.

use async_trait::async_trait;
use percent_encoding::utf8_percent_encode;
use sqlx::sqlite::SqliteConnectOptions;
use sqlx::{AssertSqlSafe, Connection as _, SqliteConnection};

use super::{Connector, EngineConnection, PATH, UrlError, UrlParts, decode, strip_prefix_ci};
use crate::connections::{AccessLevel, ConnectionInput, Engine};
use crate::ssh::Endpoint;

/// Opens the existing file only, never creating one. RO opens with `mode=ro`. sqlx turns on
/// `foreign_keys` per connection and leaves `journal_mode` alone, so the file itself isn't changed.
#[derive(Debug)]
pub struct SqliteConnector {
    options: SqliteConnectOptions,
}

impl SqliteConnector {
    pub fn new(input: &ConnectionInput) -> Self {
        let options = SqliteConnectOptions::new()
            .filename(input.file_path.as_deref().unwrap_or_default())
            .create_if_missing(false)
            .read_only(input.access_level == AccessLevel::Ro);

        Self { options }
    }
}

#[async_trait]
impl Connector for SqliteConnector {
    /// SQLite files are local, so there is never a tunnel.
    async fn connect(
        &self,
        _via: Option<&Endpoint>,
    ) -> Result<Box<dyn EngineConnection>, sqlx::Error> {
        let conn = SqliteConnection::connect_with(&self.options).await?;
        Ok(Box::new(SqliteEngineConnection(conn)))
    }
}

struct SqliteEngineConnection(SqliteConnection);

#[async_trait]
impl EngineConnection for SqliteEngineConnection {
    async fn server_version(&mut self) -> Result<String, sqlx::Error> {
        let version: String = sqlx::query_scalar(
            r#"
            SELECT
                sqlite_version()
            "#,
        )
        .fetch_one(&mut self.0)
        .await?;

        Ok(format!("SQLite {version}"))
    }

    async fn ping(&mut self) -> Result<(), sqlx::Error> {
        self.0.ping().await
    }

    async fn execute(&mut self, sql: &str) -> Result<(), sqlx::Error> {
        // User-written SQL (startup SQL, scripts) is what `AssertSqlSafe` is for.
        sqlx::raw_sql(AssertSqlSafe(sql.to_owned()))
            .execute(&mut self.0)
            .await?;
        Ok(())
    }

    #[cfg(test)]
    async fn fetch_text(&mut self, sql: &str) -> Result<String, sqlx::Error> {
        sqlx::query_scalar(AssertSqlSafe(sql.to_owned()))
            .fetch_one(&mut self.0)
            .await
    }

    async fn close(self: Box<Self>) {
        let _ = self.0.close().await;
    }
}

/// `None` when `text` is neither a `sqlite:` / `file:` URL nor an absolute file path.
pub(super) fn parse_url(text: &str) -> Option<Result<UrlParts, UrlError>> {
    if let Some(rest) = strip_prefix_ci(text, "sqlite:").or_else(|| strip_prefix_ci(text, "file:"))
    {
        return Some(parse(rest));
    }

    is_absolute_path(text).then(|| Ok(parts(text.to_string(), Vec::new())))
}

/// `rest` is what follows `sqlite:` or `file:`: `///abs/path`, `//abs/path`, `/abs/path`, or a
/// Windows path, optionally followed by `?query`.
fn parse(rest: &str) -> Result<UrlParts, UrlError> {
    let (path, query) = rest.split_once('?').unwrap_or((rest, ""));
    let path = decode(path.trim_start_matches("//"))?;

    // `/C:/data/app.db` (as in `sqlite:///C:/…` and `file:///C:/…`) is a Windows drive path.
    let path = match path.strip_prefix('/') {
        Some(rest) if is_drive_path(rest) => rest.to_string(),
        _ => path,
    };

    if path.is_empty() {
        return Err(UrlError::Malformed("the URL has no file path".into()));
    }

    if !is_absolute_path(&path) {
        return Err(UrlError::Unsupported(format!(
            "SQLite paths must be absolute; {path:?} is relative"
        )));
    }

    let ignored = url::form_urlencoded::parse(query.as_bytes())
        .map(|(key, _)| key.into_owned())
        .collect();

    let path = if is_drive_path(&path) {
        path.replace('/', "\\")
    } else {
        path
    };
    Ok(parts(path, ignored))
}

fn parts(file_path: String, ignored_params: Vec<String>) -> UrlParts {
    UrlParts {
        engine: Some(Engine::Sqlite),
        file_path: Some(file_path),
        ignored_params,
        ..UrlParts::default()
    }
}

/// `sqlite:///abs/path` on Unix, `sqlite:///C:/dir/file.db` for Windows paths.
pub(super) fn build_url(path: &str) -> String {
    let path = if is_drive_path(path) {
        format!("/{}", path.replace('\\', "/"))
    } else {
        path.to_string()
    };

    format!("sqlite://{}", utf8_percent_encode(&path, PATH))
}

/// `C:\…` or `C:/…`.
fn is_drive_path(path: &str) -> bool {
    let bytes = path.as_bytes();
    bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && matches!(bytes[2], b'/' | b'\\')
}

/// Absolute on any platform: `/…`, `C:\…`, or a UNC path `\\server\share\…`. Checked by hand so
/// pasted Windows paths are recognized the same way on every OS.
fn is_absolute_path(path: &str) -> bool {
    path.starts_with('/') || path.starts_with(r"\\") || is_drive_path(path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::{build_url as build_any, parse_url as parse_any};

    #[test]
    fn parses_urls_and_paths() {
        let cases = [
            ("sqlite:///home/me/app.db", "/home/me/app.db"),
            ("sqlite:/home/me/app.db", "/home/me/app.db"),
            ("file:///home/me/my%20app.db?mode=ro", "/home/me/my app.db"),
            ("sqlite:///C:/Users/me/app.db", r"C:\Users\me\app.db"),
            ("sqlite://C:/Users/me/app.db", r"C:\Users\me\app.db"),
            ("file:///D:/data/x.sqlite3", r"D:\data\x.sqlite3"),
            ("/var/lib/app.db", "/var/lib/app.db"),
            (r"C:\Users\me\app.db", r"C:\Users\me\app.db"),
            (r"\\server\share\app.db", r"\\server\share\app.db"),
        ];

        for (input, expected) in cases {
            let parts = parse_any(input).unwrap();
            assert_eq!(parts.engine, Some(Engine::Sqlite), "{input}");
            assert_eq!(parts.file_path.as_deref(), Some(expected), "{input}");
        }

        assert_eq!(
            parse_any("file:///tmp/a.db?mode=ro&cache=shared")
                .unwrap()
                .ignored_params,
            ["mode", "cache"]
        );
    }

    #[test]
    fn rejects_relative_or_empty_paths() {
        assert!(matches!(
            parse_any("sqlite://data.db"),
            Err(UrlError::Unsupported(_))
        ));
        assert!(matches!(parse_any("sqlite:"), Err(UrlError::Malformed(_))));
    }

    #[test]
    fn round_trip() {
        for path in ["/home/me/my app.db", r"C:\Users\me\data #1.db"] {
            let mut input = ConnectionInput::new("f", Engine::Sqlite, AccessLevel::Rw);
            input.file_path = Some(path.into());

            let url = build_any(&input);
            assert_eq!(
                parse_any(&url).unwrap().file_path.as_deref(),
                Some(path),
                "{url}"
            );
        }

        assert_eq!(
            build_url(r"C:\Users\me\app.db"),
            "sqlite:///C:/Users/me/app.db"
        );
    }
}
