//! Database engines. Each engine turns a connection's settings into a [`Connector`], wraps its driver
//! connection in an [`EngineConnection`], and reads and writes its own connection URLs. Sessions only
//! use the two traits; [`parse_url`] and [`build_url`] pick the engine.

mod postgres;
mod sqlite;

use std::fmt::Debug;
use std::sync::Arc;

use async_trait::async_trait;
use percent_encoding::{AsciiSet, CONTROLS, percent_decode_str};
use serde::{Deserialize, Serialize};

use crate::connections::{ConnectionInput, Engine, SslMode};
use crate::ssh::Endpoint;

/// Opens connections with fixed settings. Kept by a session so it can reconnect the same way.
#[async_trait]
pub trait Connector: Debug + Send + Sync {
    /// Connects directly, or through an SSH tunnel's local endpoint when `via` is set.
    async fn connect(
        &self,
        via: Option<&Endpoint>,
    ) -> Result<Box<dyn EngineConnection>, sqlx::Error>;
}

/// One open database connection.
#[async_trait]
pub trait EngineConnection: Send {
    /// Engine name and version for display, e.g. "PostgreSQL 17.2" or "SQLite 3.46.0".
    async fn server_version(&mut self) -> Result<String, sqlx::Error>;

    async fn ping(&mut self) -> Result<(), sqlx::Error>;

    /// Runs one or more statements, ignoring any rows.
    async fn execute(&mut self, sql: &str) -> Result<(), sqlx::Error>;

    /// The first column of the first row, as text.
    #[cfg(test)]
    async fn fetch_text(&mut self, sql: &str) -> Result<String, sqlx::Error>;

    /// Closes the connection. Errors are ignored: they only mean it was already gone.
    async fn close(self: Box<Self>);
}

/// The connector for `input`'s engine. `password` comes from the credential store or a prompt.
pub fn connector(input: &ConnectionInput, password: Option<&str>) -> Arc<dyn Connector> {
    match input.engine {
        Engine::Postgres => Arc::new(postgres::PostgresConnector::new(input, password)),
        Engine::Sqlite => Arc::new(sqlite::SqliteConnector::new(input)),
    }
}

/// Connection fields read from a URL ("Paste a connection URL", the Fields/URL toggle). The password
/// is kept apart from the connection so it can go to the credential store. `ignored_params` lists
/// query parameters that have no matching field.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct UrlParts {
    pub engine: Option<Engine>,
    pub host: Option<String>,
    pub port: Option<u16>,
    pub database: Option<String>,
    pub username: Option<String>,
    pub password: Option<String>,
    pub ssl_mode: Option<SslMode>,
    pub ca_cert_path: Option<String>,
    pub connect_timeout_s: Option<u32>,
    pub file_path: Option<String>,
    pub ignored_params: Vec<String>,
}

impl UrlParts {
    /// Copies the URL's fields into `input`, replacing its engine and server or file fields.
    /// Fields the URL doesn't mention are cleared, so the result matches the URL exactly.
    pub fn apply_to(&self, input: &mut ConnectionInput) {
        if let Some(engine) = self.engine {
            input.engine = engine;
        }

        input.host = self.host.clone();
        input.port = self.port;
        input.database = self.database.clone();
        input.username = self.username.clone();
        input.ssl_mode = self.ssl_mode;
        input.ca_cert_path = self.ca_cert_path.clone();
        input.file_path = self.file_path.clone();
        if self.connect_timeout_s.is_some() {
            input.connect_timeout_s = self.connect_timeout_s;
        }
    }
}

#[derive(Debug, PartialEq, Eq, thiserror::Error)]
pub enum UrlError {
    #[error("not a connection URL; expected postgresql://… , sqlite:… , or a file path")]
    UnknownScheme,
    #[error("invalid URL: {0}")]
    Malformed(String),
    #[error("{0}")]
    Unsupported(String),
}

/// Parses a connection URL for any engine: `postgresql://…`, `sqlite:…`, `file:…`, or a plain
/// absolute file path.
pub fn parse_url(text: &str) -> Result<UrlParts, UrlError> {
    let text = text.trim();
    postgres::parse_url(text)
        .or_else(|| sqlite::parse_url(text))
        .unwrap_or(Err(UrlError::UnknownScheme))
}

/// The URL for a connection, for display and copying. Never includes the password.
pub fn build_url(input: &ConnectionInput) -> String {
    match input.engine {
        Engine::Postgres => postgres::build_url(input),
        Engine::Sqlite => sqlite::build_url(input.file_path.as_deref().unwrap_or_default()),
    }
}

/// Characters escaped in a URL path (a database name or file path).
const PATH: &AsciiSet = &CONTROLS
    .add(b' ')
    .add(b'"')
    .add(b'#')
    .add(b'%')
    .add(b'<')
    .add(b'>')
    .add(b'?')
    .add(b'`')
    .add(b'{')
    .add(b'}');

fn strip_prefix_ci<'a>(text: &'a str, prefix: &str) -> Option<&'a str> {
    let head = text.get(..prefix.len())?;
    head.eq_ignore_ascii_case(prefix)
        .then(|| &text[prefix.len()..])
}

fn decode(text: &str) -> Result<String, UrlError> {
    percent_decode_str(text)
        .decode_utf8()
        .map(|s| s.into_owned())
        .map_err(|_| UrlError::Malformed("contains invalid percent-encoding".into()))
}

fn non_empty(value: String) -> Option<String> {
    (!value.is_empty()).then_some(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::connections::AccessLevel;

    #[test]
    fn unknown_schemes_and_text_are_rejected() {
        assert_eq!(parse_url("mysql://h/db"), Err(UrlError::UnknownScheme));
        assert_eq!(parse_url("just words"), Err(UrlError::UnknownScheme));
    }

    #[test]
    fn parse_picks_the_engine() {
        assert_eq!(
            parse_url("  postgres://h  ").unwrap().engine,
            Some(Engine::Postgres)
        );
        assert_eq!(
            parse_url("sqlite:///tmp/a.db").unwrap().engine,
            Some(Engine::Sqlite)
        );
        assert_eq!(parse_url(r"C:\a.db").unwrap().engine, Some(Engine::Sqlite));
    }

    #[test]
    fn apply_switches_engine_and_clears_unmentioned_fields() {
        let mut input = ConnectionInput::new("db", Engine::Postgres, AccessLevel::Rw);
        input.host = Some("old".into());
        input.database = Some("old".into());
        input.connect_timeout_s = Some(9);

        parse_url("/tmp/a.db").unwrap().apply_to(&mut input);

        assert_eq!(input.engine, Engine::Sqlite);
        assert_eq!(input.host, None);
        assert_eq!(input.database, None);
        assert_eq!(input.file_path.as_deref(), Some("/tmp/a.db"));
        assert_eq!(input.connect_timeout_s, Some(9));
    }
}
