//! Running statements: pages, columns, errors, access levels, cancel, timeouts and reconnects.
//! SQLite always; PostgreSQL needs Docker.

use std::time::Duration;

use super::tests::{sqlite_file, sqlite_target};
use super::*;
use crate::classify::StatementKind;
use crate::connections::AccessLevel;

/// A query that keeps SQLite busy for a long time, for cancel and timeout tests.
const SLOW_SQLITE: &str = r#"
    WITH RECURSIVE
        n (i) AS (
            SELECT
                1
            UNION ALL
            SELECT
                i + 1
            FROM
                n
            WHERE
                i < 100000000
        )
    SELECT
        count(*)
    FROM
        n
"#;

async fn sqlite_session(dir: &tempfile::TempDir, level: AccessLevel) -> Session {
    let path = sqlite_file(dir.path()).await;
    Session::open(sqlite_target(&path, level)).await.unwrap()
}

#[tokio::test]
async fn pages_through_a_result() {
    let dir = tempfile::tempdir().unwrap();
    let mut session = sqlite_session(&dir, AccessLevel::Rw).await;
    for i in 2..=5 {
        session
            .run(&format!("INSERT INTO items (name) VALUES ('item {i}')"), 10)
            .await
            .unwrap();
    }

    let first = session
        .run(
            r#"
            SELECT
                id,
                name,
                NULL AS empty
            FROM
                items
            ORDER BY
                id
            "#,
            2,
        )
        .await
        .unwrap();
    assert_eq!(first.kind, StatementKind::Read);
    let columns: Vec<_> = first.columns.unwrap().into_iter().map(|c| c.name).collect();
    assert_eq!(columns, ["id", "name", "empty"]);
    assert_eq!(
        first.rows,
        vec![
            vec![Some("1".into()), Some("first".into()), None],
            vec![Some("2".into()), Some("item 2".into()), None],
        ]
    );
    assert!(first.more);
    assert_eq!(first.rows_affected, None);

    let second = session.fetch_more().await.unwrap();
    assert_eq!(second.rows.len(), 2);
    assert!(second.more);

    let last = session.fetch_more().await.unwrap();
    assert_eq!(last.rows.len(), 1);
    assert!(!last.more);
    assert!(matches!(
        session.fetch_more().await,
        Err(SessionError::NoOpenResult)
    ));

    // A new statement closes an open result first.
    session.run("SELECT id FROM items", 1).await.unwrap();
    let count = session.run("SELECT count(*) FROM items", 10).await.unwrap();
    assert_eq!(count.rows, vec![vec![Some("5".into())]]);
}

#[tokio::test]
async fn reports_writes_empty_results_and_errors() {
    let dir = tempfile::tempdir().unwrap();
    let mut session = sqlite_session(&dir, AccessLevel::Ddl).await;

    let update = session
        .run("UPDATE items SET name = 'renamed'", 10)
        .await
        .unwrap();
    assert_eq!(update.kind, StatementKind::Write);
    assert_eq!(update.columns, None);
    assert_eq!(update.rows_affected, Some(1));

    let empty = session
        .run("SELECT id, name FROM items WHERE id < 0", 10)
        .await
        .unwrap();
    assert_eq!(empty.columns.map(|c| c.len()), Some(2));
    assert!(empty.rows.is_empty());

    let typed = session
        .run("SELECT 1, 2.5, x'00ff', 'text', NULL", 10)
        .await
        .unwrap();
    assert_eq!(
        typed.rows[0],
        vec![
            Some("1".into()),
            Some("2.5".into()),
            Some("x'00ff' (2 bytes)".into()),
            Some("text".into()),
            None
        ]
    );

    let created = session
        .run("CREATE TABLE extra (a INTEGER)", 10)
        .await
        .unwrap();
    assert_eq!(created.kind, StatementKind::Ddl);
    assert_eq!(created.columns, None);

    match session.run("SELECT missing FROM items", 10).await {
        Err(SessionError::Query(e)) => assert!(e.message.contains("no such column"), "{e:?}"),
        other => panic!("{other:?}"),
    }
    // The session still works after an error.
    session.run("SELECT 1", 10).await.unwrap();
}

#[tokio::test]
async fn blocks_statements_above_the_access_level() {
    let dir = tempfile::tempdir().unwrap();
    let mut ro = sqlite_session(&dir, AccessLevel::Ro).await;
    assert!(matches!(
        ro.run("DELETE FROM items", 10).await,
        Err(SessionError::Blocked {
            kind: StatementKind::Write,
            level: AccessLevel::Ro
        })
    ));
    ro.run("SELECT * FROM items", 10).await.unwrap();

    let path = dir.path().join("app.db").display().to_string();
    let mut rw = Session::open(sqlite_target(&path, AccessLevel::Rw))
        .await
        .unwrap();
    let err = rw.run("DROP TABLE items", 10).await.unwrap_err();
    assert_eq!(
        err.to_string(),
        "DDL statements can't run on a RW connection"
    );
}

#[tokio::test]
async fn cancels_and_times_out() {
    let dir = tempfile::tempdir().unwrap();
    let mut session = sqlite_session(&dir, AccessLevel::Rw).await;

    let cancel = session.cancel_handle();
    let stopper = tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(200)).await;
        cancel.cancel().await.unwrap();
    });
    assert!(matches!(
        session.run(SLOW_SQLITE, 10).await,
        Err(SessionError::Canceled)
    ));
    stopper.await.unwrap();
    // The interrupt doesn't stick to the next statement.
    session.run("SELECT 1", 10).await.unwrap();

    let path = dir.path().join("app.db").display().to_string();
    let mut input = crate::connections::ConnectionInput::new("t", Engine::Sqlite, AccessLevel::Rw);
    input.file_path = Some(path);
    input.query_timeout_s = Some(1);
    let target = ConnectTarget::new(
        Uuid::new_v4(),
        &input,
        &Credentials::default(),
        &super::tests::no_ssh(),
    )
    .unwrap();
    let mut limited = Session::open(target).await.unwrap();
    match limited.run(SLOW_SQLITE, 10).await {
        Err(SessionError::QueryTimeout(limit)) => assert_eq!(limit, Duration::from_secs(1)),
        other => panic!("{other:?}"),
    }
}

#[tokio::test]
async fn reconnects_when_the_connection_was_lost() {
    let dir = tempfile::tempdir().unwrap();
    let mut session = sqlite_session(&dir, AccessLevel::Rw).await;
    session.drop_connection().await;

    let out = session.run("SELECT name FROM items", 10).await.unwrap();
    assert_eq!(out.rows, vec![vec![Some("first".into())]]);
}

mod postgres {
    use testcontainers::ImageExt;
    use testcontainers::runners::AsyncRunner;
    use testcontainers_modules::postgres::Postgres;

    use super::super::tests::postgres::{PASSWORD, pg_input, pg_target};
    use super::*;

    #[tokio::test]
    async fn postgres_runs() {
        let container = match Postgres::default().with_tag("17-alpine").start().await {
            Ok(container) => container,
            Err(e) => {
                eprintln!("skipping PostgreSQL run tests: Docker is not available ({e})");
                return;
            }
        };
        let port = container.get_host_port_ipv4(5432).await.unwrap();
        let mut session = Session::open(pg_target(&pg_input(port, AccessLevel::Ddl), PASSWORD))
            .await
            .unwrap();

        session.set_transaction_mode(TransactionMode::Auto).unwrap();

        // Values arrive as text, whatever their type.
        let out = session
            .run(
                r#"
                SELECT
                    1::int4 AS i,
                    2.50::numeric AS n,
                    true AS b,
                    '{"a": 1}'::jsonb AS j,
                    '2024-06-01'::date AS d,
                    NULL::text AS t,
                    ARRAY[1, 2] AS a
                "#,
                10,
            )
            .await
            .unwrap();
        let types: Vec<_> = out
            .columns
            .unwrap()
            .into_iter()
            .map(|c| c.type_name)
            .collect();
        assert_eq!(
            types,
            ["INT4", "NUMERIC", "BOOL", "JSONB", "DATE", "TEXT", "INT4[]"]
        );
        assert_eq!(
            out.rows[0],
            vec![
                Some("1".into()),
                Some("2.50".into()),
                Some("t".into()),
                Some(r#"{"a": 1}"#.into()),
                Some("2024-06-01".into()),
                None,
                Some("{1,2}".into()),
            ]
        );

        // Paging over a large result, then closing it early.
        let first = session
            .run("SELECT g FROM generate_series(1, 10000) g", 100)
            .await
            .unwrap();
        assert!(first.more);
        let second = session.fetch_more().await.unwrap();
        assert_eq!(second.rows[0], vec![Some("101".into())]);
        session.close_result().await;
        let after = session.run("SELECT 'ok'", 10).await.unwrap();
        assert_eq!(after.rows, vec![vec![Some("ok".into())]]);

        // Errors carry code, hint and position.
        match session.run("SELECT * FROM nowhere", 10).await {
            Err(SessionError::Query(e)) => {
                assert_eq!(e.code.as_deref(), Some("42P01"));
                assert_eq!(e.position, Some(15));
            }
            other => panic!("{other:?}"),
        }

        // Notices belong to the statement that raised them.
        let noticed = session
            .run(
                "DO $$ BEGIN RAISE NOTICE 'hello from %', 'plpgsql'; END $$",
                10,
            )
            .await
            .unwrap();
        assert_eq!(noticed.kind, StatementKind::Write);
        assert_eq!(
            noticed.notices,
            vec![crate::query::Notice {
                level: "notice".into(),
                message: "hello from plpgsql".into()
            }]
        );

        // Writes report rows affected; an empty SELECT still has its columns.
        session.run("CREATE TABLE t (a int)", 10).await.unwrap();
        let inserted = session
            .run("INSERT INTO t SELECT generate_series(1, 3)", 10)
            .await
            .unwrap();
        assert_eq!(inserted.rows_affected, Some(3));
        let empty = session
            .run("SELECT a FROM t WHERE a > 10", 10)
            .await
            .unwrap();
        assert_eq!(empty.columns.map(|c| c.len()), Some(1));

        // Cancel from outside the session's lock.
        let cancel = session.cancel_handle();
        let stopper = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(300)).await;
            cancel.cancel().await.unwrap();
        });
        assert!(matches!(
            session.run("SELECT pg_sleep(10)", 10).await,
            Err(SessionError::Canceled)
        ));
        stopper.await.unwrap();
        session.run("SELECT 1", 10).await.unwrap();

        // The query timeout cancels on its own.
        let mut input = pg_input(port, AccessLevel::Rw);
        input.query_timeout_s = Some(1);
        let mut limited = Session::open(pg_target(&input, PASSWORD)).await.unwrap();
        assert!(matches!(
            limited.run("SELECT pg_sleep(10)", 10).await,
            Err(SessionError::QueryTimeout(_))
        ));
    }
}

#[tokio::test]
async fn manual_transactions_begin_on_writes_and_commit_or_roll_back() {
    let dir = tempfile::tempdir().unwrap();
    let mut session = sqlite_session(&dir, AccessLevel::Rw).await;
    session
        .set_transaction_mode(TransactionMode::Manual)
        .unwrap();

    // Reads don't open a transaction; the first write does.
    assert!(
        !session
            .run("SELECT * FROM items", 10)
            .await
            .unwrap()
            .in_transaction
    );
    let out = session
        .run("UPDATE items SET name = 'changed'", 10)
        .await
        .unwrap();
    assert!(out.in_transaction);
    assert_eq!(session.transaction_statements().len(), 1);
    assert_eq!(session.transaction_statements()[0].rows_affected, Some(1));
    assert!(session.set_transaction_mode(TransactionMode::Auto).is_err());

    session.rollback().await.unwrap();
    assert!(!session.in_transaction());
    let name = session.run("SELECT name FROM items", 10).await.unwrap();
    assert_eq!(name.rows, vec![vec![Some("first".into())]]);

    session
        .run("UPDATE items SET name = 'kept'", 10)
        .await
        .unwrap();
    session.commit().await.unwrap();
    assert!(session.transaction_statements().is_empty());

    // Typed BEGIN / COMMIT work in auto mode too.
    session.set_transaction_mode(TransactionMode::Auto).unwrap();
    assert!(session.run("BEGIN", 10).await.unwrap().in_transaction);
    assert!(!session.run("COMMIT", 10).await.unwrap().in_transaction);

    let path = dir.path().join("app.db").display().to_string();
    let mut other = Session::open(sqlite_target(&path, AccessLevel::Ro))
        .await
        .unwrap();
    let seen = other.run("SELECT name FROM items", 10).await.unwrap();
    assert_eq!(seen.rows, vec![vec![Some("kept".into())]]);
}
