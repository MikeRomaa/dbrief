//! PostgreSQL via sqlx, and `postgresql://` connection URLs.

use async_trait::async_trait;
use percent_encoding::{AsciiSet, CONTROLS, utf8_percent_encode};
use sqlx::postgres::{PgConnectOptions, PgSslMode};
use sqlx::{AssertSqlSafe, Connection as _, PgConnection};
use url::Url;

use super::{
    Connector, EngineConnection, PATH, UrlError, UrlParts, decode, non_empty, strip_prefix_ci,
};
use crate::connections::{AccessLevel, ConnectionInput, Engine, SslMode};
use crate::ssh::Endpoint;

/// Reported to the server as `application_name`.
const APPLICATION_NAME: &str = "DBrief";

/// Every option is set explicitly so `PG*` environment variables don't leak into the connection.
/// RO connections are read-only at the server: every transaction starts with
/// `default_transaction_read_only`. A default schema becomes the `search_path`.
///
/// SSL follows libpq's `sslmode`, defaulting to `prefer`. A CA certificate replaces the system roots
/// for `verify-ca` and `verify-full`.
pub struct PostgresConnector {
    options: PgConnectOptions,
}

/// `PgConnectOptions` prints the password, so only the safe parts are shown.
impl std::fmt::Debug for PostgresConnector {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let o = &self.options;
        f.debug_struct("PostgresConnector")
            .field("host", &o.get_host())
            .field("port", &o.get_port())
            .field("database", &o.get_database())
            .field("username", &o.get_username())
            .field("ssl_mode", &o.get_ssl_mode())
            .finish_non_exhaustive()
    }
}

impl PostgresConnector {
    pub fn new(input: &ConnectionInput, password: Option<&str>) -> Self {
        let mut options = PgConnectOptions::new_without_pgpass()
            .host(input.host.as_deref().unwrap_or_default())
            .port(input.port.unwrap_or(5432))
            .application_name(APPLICATION_NAME)
            .ssl_mode(pg_ssl_mode(input.ssl_mode.unwrap_or(SslMode::Prefer)));

        if let Some(ca) = input
            .ca_cert_path
            .as_deref()
            .filter(|c| !c.trim().is_empty())
        {
            options = options.ssl_root_cert(ca.trim());
        }

        if let Some(user) = input.username.as_deref().filter(|u| !u.is_empty()) {
            options = options.username(user);
        }

        if let Some(database) = input.database.as_deref().filter(|d| !d.is_empty()) {
            options = options.database(database);
        }

        if let Some(password) = password {
            options = options.password(password);
        }

        let mut server_settings = Vec::new();
        if input.access_level == AccessLevel::Ro {
            server_settings.push(("default_transaction_read_only", "on".to_string()));
        }

        if let Some(schema) = input
            .default_schema
            .as_deref()
            .filter(|s| !s.trim().is_empty())
        {
            server_settings.push(("search_path", quote_ident(schema.trim())));
        }

        if !server_settings.is_empty() {
            options = options.options(server_settings);
        }

        Self { options }
    }
}

#[async_trait]
impl Connector for PostgresConnector {
    async fn connect(
        &self,
        via: Option<&Endpoint>,
    ) -> Result<Box<dyn EngineConnection>, sqlx::Error> {
        let conn = match via {
            None => PgConnection::connect_with(&self.options).await?,
            Some(endpoint) => {
                PgConnection::connect_with(&through(&self.options, endpoint)?).await?
            }
        };
        Ok(Box::new(PostgresConnection(conn)))
    }
}

/// Options that dial the tunnel instead of the server. Through a Unix socket the host name stays, so
/// TLS is still verified against the real server.
fn through(
    options: &PgConnectOptions,
    endpoint: &Endpoint,
) -> Result<PgConnectOptions, sqlx::Error> {
    match endpoint {
        #[cfg(unix)]
        Endpoint::UnixDir(dir) => Ok(options.clone().socket(dir)),
        Endpoint::Tcp(addr) => {
            if matches!(options.get_ssl_mode(), PgSslMode::VerifyFull) {
                return Err(sqlx::Error::Configuration(
                    "verify-full can't check the host name through an SSH tunnel on this platform; use verify-ca"
                        .into(),
                ));
            }
            Ok(options
                .clone()
                .host(&addr.ip().to_string())
                .port(addr.port()))
        }
    }
}

fn pg_ssl_mode(mode: SslMode) -> PgSslMode {
    match mode {
        SslMode::Disable => PgSslMode::Disable,
        SslMode::Allow => PgSslMode::Allow,
        SslMode::Prefer => PgSslMode::Prefer,
        SslMode::Require => PgSslMode::Require,
        SslMode::VerifyCa => PgSslMode::VerifyCa,
        SslMode::VerifyFull => PgSslMode::VerifyFull,
    }
}

struct PostgresConnection(PgConnection);

#[async_trait]
impl EngineConnection for PostgresConnection {
    async fn server_version(&mut self) -> Result<String, sqlx::Error> {
        let version: String = sqlx::query_scalar(
            r#"
            SHOW
                server_version
            "#,
        )
        .fetch_one(&mut self.0)
        .await?;

        // e.g. "17.2 (Debian 17.2-1.pgdg120+1)" → "PostgreSQL 17.2"
        Ok(format!(
            "PostgreSQL {}",
            version.split_whitespace().next().unwrap_or(&version)
        ))
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

/// A PostgreSQL identifier in double quotes, so names keep their case and spaces.
fn quote_ident(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

/// Characters escaped in the user part of a URL.
const USERINFO: &AsciiSet = &CONTROLS
    .add(b' ')
    .add(b'"')
    .add(b'#')
    .add(b'%')
    .add(b'/')
    .add(b':')
    .add(b'<')
    .add(b'>')
    .add(b'?')
    .add(b'@')
    .add(b'[')
    .add(b'\\')
    .add(b']')
    .add(b'^')
    .add(b'`')
    .add(b'{')
    .add(b'|')
    .add(b'}');

/// A database name is a single path segment, so `/` is escaped too.
const DATABASE: &AsciiSet = &PATH.add(b'/');

/// `None` when `text` isn't a `postgres://` or `postgresql://` URL.
pub(super) fn parse_url(text: &str) -> Option<Result<UrlParts, UrlError>> {
    if strip_prefix_ci(text, "postgres://").is_none()
        && strip_prefix_ci(text, "postgresql://").is_none()
    {
        return None;
    }

    Some(parse(text))
}

fn parse(text: &str) -> Result<UrlParts, UrlError> {
    let url = Url::parse(text).map_err(|e| UrlError::Malformed(e.to_string()))?;

    let host = url
        .host_str()
        .map(|h| h.trim_start_matches('[').trim_end_matches(']'));
    if host.is_some_and(|h| h.contains(',')) {
        return Err(UrlError::Unsupported(
            "URLs with several hosts are not supported".into(),
        ));
    }

    let path = url.path().trim_start_matches('/');
    if path.contains('/') {
        return Err(UrlError::Malformed(
            "the path should be just the database name".into(),
        ));
    }

    let mut parts = UrlParts {
        engine: Some(Engine::Postgres),
        host: host.map(decode).transpose()?.and_then(non_empty),
        port: url.port(),
        database: non_empty(decode(path)?),
        username: non_empty(decode(url.username())?),
        password: url.password().map(decode).transpose()?,
        ..UrlParts::default()
    };

    for (key, value) in url.query_pairs() {
        match key.as_ref() {
            "sslmode" => {
                let mode = value
                    .parse()
                    .map_err(|_| UrlError::Malformed(format!("unknown sslmode {value:?}")))?;
                parts.ssl_mode = Some(mode);
            }
            "sslrootcert" => parts.ca_cert_path = non_empty(value.into_owned()),
            "connect_timeout" => {
                let seconds = value.parse().map_err(|_| {
                    UrlError::Malformed(format!(
                        "connect_timeout must be a number of seconds, got {value:?}"
                    ))
                })?;
                parts.connect_timeout_s = Some(seconds);
            }
            "user" => parts.username = non_empty(value.into_owned()),
            "password" => parts.password = Some(value.into_owned()),
            "dbname" => parts.database = non_empty(value.into_owned()),
            "port" => {
                let port = value
                    .parse()
                    .map_err(|_| UrlError::Malformed(format!("invalid port {value:?}")))?;
                parts.port = Some(port);
            }
            other => parts.ignored_params.push(other.to_string()),
        }
    }

    Ok(parts)
}

pub(super) fn build_url(input: &ConnectionInput) -> String {
    let mut url = String::from("postgresql://");

    if let Some(user) = input.username.as_deref().filter(|u| !u.is_empty()) {
        url.push_str(&utf8_percent_encode(user, USERINFO).to_string());
        url.push('@');
    }

    if let Some(host) = input.host.as_deref() {
        if host.contains(':') {
            url.push_str(&format!("[{host}]"));
        } else {
            url.push_str(&utf8_percent_encode(host, USERINFO).to_string());
        }
    }

    if let Some(port) = input.port {
        url.push_str(&format!(":{port}"));
    }

    if let Some(database) = input.database.as_deref().filter(|d| !d.is_empty()) {
        url.push('/');
        url.push_str(&utf8_percent_encode(database, DATABASE).to_string());
    }

    let mut query = url::form_urlencoded::Serializer::new(String::new());
    if let Some(mode) = input.ssl_mode {
        query.append_pair("sslmode", mode.as_str());
    }

    if let Some(ca) = input.ca_cert_path.as_deref().filter(|c| !c.is_empty()) {
        query.append_pair("sslrootcert", ca);
    }

    if let Some(timeout) = input.connect_timeout_s {
        query.append_pair("connect_timeout", &timeout.to_string());
    }

    let query = query.finish();
    if !query.is_empty() {
        url.push('?');
        url.push_str(&query);
    }

    url
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::parse_url;

    fn pg() -> ConnectionInput {
        ConnectionInput::new("db", Engine::Postgres, AccessLevel::Rw)
    }

    #[test]
    fn quotes_identifiers() {
        assert_eq!(quote_ident("app"), "\"app\"");
        assert_eq!(
            quote_ident("My \"odd\" schema"),
            "\"My \"\"odd\"\" schema\""
        );
    }

    #[test]
    fn options_carry_ro_and_schema_settings() {
        let mut input = ConnectionInput::new("pg", Engine::Postgres, AccessLevel::Ro);
        input.host = Some("db".into());
        input.default_schema = Some("app".into());

        let options = PostgresConnector::new(&input, Some("pw")).options;
        assert_eq!(options.get_host(), "db");
        assert_eq!(options.get_port(), 5432);
        let settings = options.get_options().unwrap_or_default();
        assert!(
            settings.contains("default_transaction_read_only=on"),
            "{settings}"
        );
        assert!(settings.contains("search_path=\"app\""), "{settings}");

        input.access_level = AccessLevel::Rw;
        input.default_schema = None;
        assert_eq!(
            PostgresConnector::new(&input, None).options.get_options(),
            None
        );
    }

    #[test]
    fn options_carry_ssl_settings_and_tunnel_endpoints() {
        let mut input = pg();
        input.host = Some("db.example.com".into());
        input.port = Some(5433);
        assert!(matches!(
            PostgresConnector::new(&input, None).options.get_ssl_mode(),
            PgSslMode::Prefer
        ));

        input.ssl_mode = Some(SslMode::VerifyFull);
        input.ca_cert_path = Some(" /certs/ca.pem ".into());
        let options = PostgresConnector::new(&input, None).options;
        assert!(matches!(options.get_ssl_mode(), PgSslMode::VerifyFull));

        let tcp = Endpoint::Tcp("127.0.0.1:40000".parse().unwrap());
        assert!(through(&options, &tcp).is_err());

        #[cfg(unix)]
        {
            let unix = through(&options, &Endpoint::UnixDir("/tmp/t".into())).unwrap();
            assert_eq!(unix.get_host(), "db.example.com");
            assert_eq!(
                unix.get_socket().map(|p| p.display().to_string()),
                Some("/tmp/t".into())
            );
        }

        input.ssl_mode = Some(SslMode::VerifyCa);
        let options = PostgresConnector::new(&input, None).options;
        let tcp = through(&options, &tcp).unwrap();
        assert_eq!((tcp.get_host(), tcp.get_port()), ("127.0.0.1", 40000));
    }

    #[test]
    fn parses_a_full_url() {
        let parts = parse_url(
            "postgresql://app%40corp:p%2Fss@db.example.com:6543/my%20db?sslmode=verify-full&sslrootcert=/certs/ca.pem&connect_timeout=7&application_name=x",
        )
        .unwrap();

        assert_eq!(
            parts,
            UrlParts {
                engine: Some(Engine::Postgres),
                host: Some("db.example.com".into()),
                port: Some(6543),
                database: Some("my db".into()),
                username: Some("app@corp".into()),
                password: Some("p/ss".into()),
                ssl_mode: Some(SslMode::VerifyFull),
                ca_cert_path: Some("/certs/ca.pem".into()),
                connect_timeout_s: Some(7),
                file_path: None,
                ignored_params: vec!["application_name".into()],
            }
        );
    }

    #[test]
    fn parses_minimal_and_alternate_forms() {
        let parts = parse_url("postgres://localhost").unwrap();
        assert_eq!(parts.host.as_deref(), Some("localhost"));
        assert_eq!(
            (
                parts.port,
                parts.database.as_deref(),
                parts.username.as_deref()
            ),
            (None, None, None)
        );

        let ipv6 = parse_url("postgresql://[::1]:5432/app").unwrap();
        assert_eq!(ipv6.host.as_deref(), Some("::1"));

        let params = parse_url("POSTGRESQL://h/?user=u&dbname=d&port=5433&password=pw").unwrap();
        assert_eq!(params.username.as_deref(), Some("u"));
        assert_eq!(params.database.as_deref(), Some("d"));
        assert_eq!(params.port, Some(5433));
        assert_eq!(params.password.as_deref(), Some("pw"));
    }

    #[test]
    fn rejects_malformed_urls() {
        for bad in [
            "postgresql://h:99999/db",
            "postgresql://h/db?sslmode=sometimes",
            "postgresql://h/db?connect_timeout=soon",
            "postgresql://h/db/extra",
            "postgresql://h/%FF",
        ] {
            assert!(
                matches!(parse_url(bad), Err(UrlError::Malformed(_))),
                "{bad}"
            );
        }

        assert!(matches!(
            parse_url("postgresql://h1,h2/db"),
            Err(UrlError::Unsupported(_))
        ));
    }

    #[test]
    fn builds_urls_without_the_password() {
        let mut input = pg();
        input.host = Some("db.example.com".into());
        input.port = Some(5432);
        input.database = Some("my db".into());
        input.username = Some("app@corp".into());
        input.ssl_mode = Some(SslMode::Require);
        input.connect_timeout_s = Some(5);

        assert_eq!(
            build_url(&input),
            "postgresql://app%40corp@db.example.com:5432/my%20db?sslmode=require&connect_timeout=5"
        );

        let mut bare = pg();
        bare.host = Some("::1".into());
        assert_eq!(build_url(&bare), "postgresql://[::1]");
        assert_eq!(build_url(&pg()), "postgresql://");
    }

    #[test]
    fn round_trip() {
        let mut input = pg();
        input.host = Some("10.0.0.5".into());
        input.port = Some(6432);
        input.database = Some("a/b?c".into());
        input.username = Some("we:ird user".into());
        input.ssl_mode = Some(SslMode::VerifyCa);
        input.ca_cert_path = Some(r"C:\certs\ca file.pem".into());
        input.connect_timeout_s = Some(30);

        let mut back = pg();
        parse_url(&build_url(&input)).unwrap().apply_to(&mut back);
        assert_eq!(back, input);
    }
}
