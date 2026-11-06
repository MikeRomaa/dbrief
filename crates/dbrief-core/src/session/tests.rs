//! SQLite tests run everywhere. PostgreSQL tests need Docker and are skipped without it.

use std::path::Path;

use sqlx::Connection as _;
use sqlx::SqliteConnection;
use sqlx::sqlite::SqliteConnectOptions;
use uuid::Uuid;

use super::*;
use crate::connections::ConnectionInput;
use crate::ssh::SshEnv;

/// Creates a SQLite file with one table and one row.
async fn sqlite_file(dir: &Path) -> String {
    let path = dir.join("app.db");
    let options = SqliteConnectOptions::new()
        .filename(&path)
        .create_if_missing(true);
    let mut conn = SqliteConnection::connect_with(&options).await.unwrap();
    sqlx::raw_sql(
        r#"
        CREATE TABLE
            items (id INTEGER PRIMARY KEY, name TEXT);
        INSERT INTO
            items (name)
        VALUES
            ('first');
        "#,
    )
    .execute(&mut conn)
    .await
    .unwrap();
    conn.close().await.unwrap();

    path.display().to_string()
}

/// For connections without a tunnel, where the SSH settings are never read.
fn no_ssh() -> SshEnv {
    SshEnv::new(Path::new("unused"))
}

fn sqlite_target(path: &str, level: AccessLevel) -> ConnectTarget {
    let mut input = ConnectionInput::new("app", Engine::Sqlite, level);
    input.file_path = Some(path.into());
    ConnectTarget::new(Uuid::new_v4(), &input, &Credentials::default(), &no_ssh()).unwrap()
}

#[tokio::test]
async fn sqlite_test_reports_version_and_latency() {
    let dir = tempfile::tempdir().unwrap();
    let path = sqlite_file(dir.path()).await;

    let result = test(&sqlite_target(&path, AccessLevel::Rw)).await.unwrap();
    assert!(
        result.server_version.starts_with("SQLite 3."),
        "{}",
        result.server_version
    );
    assert!(result.latency_ms >= 0.0);
}

#[tokio::test]
async fn sqlite_rw_session_can_write() {
    let dir = tempfile::tempdir().unwrap();
    let path = sqlite_file(dir.path()).await;

    let mut session = Session::open(sqlite_target(&path, AccessLevel::Rw))
        .await
        .unwrap();
    session
        .execute(
            r#"
            INSERT INTO
                items (name)
            VALUES
                ('second')
            "#,
        )
        .await
        .unwrap();
    let count = session
        .fetch_text(
            r#"
            SELECT
                CAST(COUNT(*) AS TEXT)
            FROM
                items
            "#,
        )
        .await
        .unwrap();
    assert_eq!(count, "2");
    session.close().await;
}

#[tokio::test]
async fn sqlite_ro_session_is_read_only_at_the_database() {
    let dir = tempfile::tempdir().unwrap();
    let path = sqlite_file(dir.path()).await;

    let mut session = Session::open(sqlite_target(&path, AccessLevel::Ro))
        .await
        .unwrap();
    let name = session
        .fetch_text(
            r#"
            SELECT
                name
            FROM
                items
            "#,
        )
        .await
        .unwrap();
    assert_eq!(name, "first");

    let err = session
        .execute(
            r#"
            DELETE FROM
                items
            "#,
        )
        .await
        .unwrap_err()
        .to_string();
    assert!(err.contains("readonly"), "{err}");
    session.close().await;
}

#[tokio::test]
async fn sqlite_never_creates_a_missing_file() {
    let dir = tempfile::tempdir().unwrap();
    let missing = dir.path().join("missing.db");

    assert!(matches!(
        Session::open(sqlite_target(
            &missing.display().to_string(),
            AccessLevel::Rw
        ))
        .await,
        Err(SessionError::Connect(_))
    ));
    assert!(!missing.exists());
}

#[tokio::test]
async fn startup_sql_runs_on_connect_and_failures_are_reported() {
    let dir = tempfile::tempdir().unwrap();
    let path = sqlite_file(dir.path()).await;

    let mut input = ConnectionInput::new("app", Engine::Sqlite, AccessLevel::Rw);
    input.file_path = Some(path);
    input.startup_sql =
        Some("CREATE TEMP TABLE startup_ran (x); INSERT INTO startup_ran VALUES ('yes');".into());
    let mut session = Session::open(
        ConnectTarget::new(Uuid::new_v4(), &input, &Credentials::default(), &no_ssh()).unwrap(),
    )
    .await
    .unwrap();
    let ran = session
        .fetch_text(
            r#"
            SELECT
                x
            FROM
                startup_ran
            "#,
        )
        .await
        .unwrap();
    assert_eq!(ran, "yes");
    session.close().await;

    input.startup_sql = Some("THIS IS NOT SQL".into());
    assert!(matches!(
        Session::open(
            ConnectTarget::new(Uuid::new_v4(), &input, &Credentials::default(), &no_ssh()).unwrap()
        )
        .await,
        Err(SessionError::StartupSql(_))
    ));
}

#[tokio::test]
async fn reconnects_automatically_without_a_transaction() {
    let dir = tempfile::tempdir().unwrap();
    let path = sqlite_file(dir.path()).await;
    let mut session = Session::open(sqlite_target(&path, AccessLevel::Rw))
        .await
        .unwrap();

    assert_eq!(session.ensure_alive().await.unwrap(), Liveness::Alive);

    session.drop_connection().await;
    assert_eq!(session.ensure_alive().await.unwrap(), Liveness::Reconnected);
    assert_eq!(session.ensure_alive().await.unwrap(), Liveness::Alive);
    session.close().await;
}

#[tokio::test]
async fn a_lost_transaction_must_be_acknowledged() {
    let dir = tempfile::tempdir().unwrap();
    let path = sqlite_file(dir.path()).await;
    let mut session = Session::open(sqlite_target(&path, AccessLevel::Rw))
        .await
        .unwrap();

    session.set_in_transaction(true);
    session.drop_connection().await;

    assert!(matches!(
        session.ensure_alive().await,
        Err(SessionError::TransactionLost)
    ));
    assert!(!session.in_transaction());

    // Still lost until acknowledged, even though no transaction is marked open any more.
    assert!(matches!(
        session.ensure_alive().await,
        Err(SessionError::TransactionLost)
    ));

    session.reconnect_after_lost_transaction().await.unwrap();
    assert_eq!(session.ensure_alive().await.unwrap(), Liveness::Alive);
    session.close().await;
}

#[tokio::test]
async fn manager_tracks_and_closes_sessions() {
    let dir = tempfile::tempdir().unwrap();
    let path = sqlite_file(dir.path()).await;
    let manager = SessionManager::default();

    let first_target = sqlite_target(&path, AccessLevel::Rw);
    let mut same_connection = sqlite_target(&path, AccessLevel::Ro);
    same_connection.connection_id = first_target.connection_id;
    let other = sqlite_target(&path, AccessLevel::Rw);

    let first = manager.open(first_target).await.unwrap();
    let second = manager.open(same_connection).await.unwrap();
    let third = manager.open(other).await.unwrap();
    assert_eq!(manager.list().await.len(), 3);
    assert_eq!(second.access_level, AccessLevel::Ro);

    assert_eq!(manager.close_connection(first.connection_id).await, 2);
    assert!(matches!(
        manager.get(first.id).await,
        Err(SessionError::NotFound(_))
    ));
    assert!(manager.get(third.id).await.is_ok());

    manager.close(third.id).await.unwrap();
    assert!(manager.list().await.is_empty());
    assert!(matches!(
        manager.close(third.id).await,
        Err(SessionError::NotFound(_))
    ));
}

mod postgres {
    use testcontainers::ImageExt;
    use testcontainers::runners::AsyncRunner;
    use testcontainers_modules::postgres::Postgres;

    use super::*;

    const PASSWORD: &str = "postgres";

    fn pg_input(port: u16, level: AccessLevel) -> ConnectionInput {
        let mut input = ConnectionInput::new("pg", Engine::Postgres, level);
        input.host = Some("127.0.0.1".into());
        input.port = Some(port);
        input.username = Some("postgres".into());
        input.database = Some("postgres".into());
        input
    }

    fn pg_target(input: &ConnectionInput, password: &str) -> ConnectTarget {
        ConnectTarget::new(
            Uuid::new_v4(),
            input,
            &Credentials::password(password),
            &no_ssh(),
        )
        .unwrap()
    }

    /// All PostgreSQL scenarios share one container, since starting one takes a few seconds.
    #[tokio::test]
    async fn postgres_sessions() {
        let container = match Postgres::default().with_tag("17-alpine").start().await {
            Ok(container) => container,
            Err(e) => {
                eprintln!("skipping PostgreSQL session tests: Docker is not available ({e})");
                return;
            }
        };
        let port = container.get_host_port_ipv4(5432).await.unwrap();

        // Test reports the version and latency.
        let result = test(&pg_target(&pg_input(port, AccessLevel::Rw), PASSWORD))
            .await
            .unwrap();
        assert!(
            result.server_version.starts_with("PostgreSQL 17"),
            "{}",
            result.server_version
        );

        // RW can write; set up a schema for the next checks.
        let mut rw = Session::open(pg_target(&pg_input(port, AccessLevel::Rw), PASSWORD))
            .await
            .unwrap();
        rw.execute(
            r#"
            CREATE SCHEMA
                "App Data";
            CREATE TABLE
                "App Data".items (name TEXT);
            INSERT INTO
                "App Data".items
            VALUES
                ('first');
            "#,
        )
        .await
        .unwrap();
        rw.close().await;

        // RO is enforced by the server.
        let mut ro = Session::open(pg_target(&pg_input(port, AccessLevel::Ro), PASSWORD))
            .await
            .unwrap();
        assert_eq!(ro.info().access_level, AccessLevel::Ro);
        assert_eq!(
            ro.fetch_text("SHOW default_transaction_read_only")
                .await
                .unwrap(),
            "on"
        );
        let err = ro
            .execute(
                r#"
                CREATE TABLE
                    nope (x INT)
                "#,
            )
            .await
            .unwrap_err()
            .to_string();
        assert!(err.contains("read-only transaction"), "{err}");
        ro.close().await;

        // Default schema sets search_path (quoted); startup SQL runs on connect and on reconnect.
        let mut input = pg_input(port, AccessLevel::Rw);
        input.default_schema = Some("App Data".into());
        input.startup_sql = Some("SET TIME ZONE 'Pacific/Auckland'".into());
        let mut session = Session::open(pg_target(&input, PASSWORD)).await.unwrap();
        let name = session
            .fetch_text(
                r#"
                SELECT
                    name
                FROM
                    items
                "#,
            )
            .await
            .unwrap();
        assert_eq!(name, "first");
        assert_eq!(
            session.fetch_text("SHOW TimeZone").await.unwrap(),
            "Pacific/Auckland"
        );

        session.drop_connection().await;
        assert_eq!(session.ensure_alive().await.unwrap(), Liveness::Reconnected);
        assert_eq!(
            session.fetch_text("SHOW TimeZone").await.unwrap(),
            "Pacific/Auckland"
        );
        session.close().await;

        // Wrong password fails to connect.
        let wrong = pg_target(&pg_input(port, AccessLevel::Rw), "wrong");
        assert!(matches!(test(&wrong).await, Err(SessionError::Connect(_))));
    }

    #[tokio::test]
    async fn connect_timeout_is_applied() {
        // A non-routable address: the attempt hangs instead of being refused.
        let mut input = pg_input(5432, AccessLevel::Rw);
        input.host = Some("10.255.255.1".into());
        input.connect_timeout_s = Some(1);

        let start = Instant::now();
        let result = test(&pg_target(&input, PASSWORD)).await;
        assert!(start.elapsed() < Duration::from_secs(5));
        assert!(
            matches!(
                result,
                Err(SessionError::Timeout(_) | SessionError::Connect(_))
            ),
            "{result:?}"
        );
    }
}
