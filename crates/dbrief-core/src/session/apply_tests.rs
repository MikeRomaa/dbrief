//! Row identity, column facts and applying staged grid changes. SQLite always; PostgreSQL needs
//! Docker.

use super::tests::sqlite_target;
use super::*;
use crate::edit::{Change, ColumnValue, EditBatch, EditInfo, NewValue, ROWID_ALIASES, RowIdentity};
use crate::grid::TableQuery;
use crate::schema::{ObjectKind, ObjectRef};

async fn sqlite_session(dir: &std::path::Path, sql: &str, level: AccessLevel) -> Session {
    use sqlx::Connection as _;
    let file = dir.join("edit.db");
    let options = sqlx::sqlite::SqliteConnectOptions::new()
        .filename(&file)
        .create_if_missing(true);
    sqlx::SqliteConnection::connect_with(&options)
        .await
        .unwrap()
        .close()
        .await
        .unwrap();
    let path = file.display().to_string();
    let mut setup = Session::open(sqlite_target(&path, AccessLevel::Ddl))
        .await
        .unwrap();
    setup.execute(sql).await.unwrap();
    setup.close().await;
    Session::open(sqlite_target(&path, level)).await.unwrap()
}

fn object(schema: &str, name: &str, kind: ObjectKind) -> ObjectRef {
    ObjectRef {
        schema: schema.into(),
        name: name.into(),
        kind,
        detail: None,
    }
}

async fn info(session: &mut Session, schema: &str, name: &str, kind: ObjectKind) -> EditInfo {
    crate::schema::edit_info(session, &object(schema, name, kind))
        .await
        .unwrap()
}

fn key(columns: &[&str], index: Option<&str>) -> Option<RowIdentity> {
    Some(RowIdentity::Key {
        columns: columns.iter().map(|c| (*c).to_owned()).collect(),
        index: index.map(Into::into),
    })
}

const SQLITE_TABLES: &str = r#"
    CREATE TABLE pk (a INTEGER, b TEXT, c TEXT, PRIMARY KEY (b, a));
    CREATE TABLE uniq (x TEXT NOT NULL, y TEXT NOT NULL, z TEXT, total INTEGER GENERATED ALWAYS AS (length(x)) VIRTUAL);
    CREATE UNIQUE INDEX uniq_xy ON uniq (x, y);
    CREATE UNIQUE INDEX uniq_y ON uniq (y);
    CREATE UNIQUE INDEX uniq_z ON uniq (z);
    CREATE UNIQUE INDEX uniq_expr ON uniq (lower(x));
    CREATE UNIQUE INDEX uniq_partial ON uniq (x) WHERE z IS NULL;
    CREATE TABLE plain (note TEXT);
    CREATE TABLE shadow (rowid TEXT, note TEXT);
    CREATE TABLE every (rowid TEXT, _rowid_ TEXT, oid TEXT);
    CREATE TABLE nokey (code TEXT PRIMARY KEY, n INT) WITHOUT ROWID;
    CREATE VIEW v AS SELECT * FROM pk;
"#;

#[tokio::test]
async fn sqlite_row_identity_and_columns() {
    let dir = tempfile::tempdir().unwrap();
    let mut session = sqlite_session(dir.path(), SQLITE_TABLES, AccessLevel::Rw).await;

    let pk = info(&mut session, "main", "pk", ObjectKind::Table).await;
    assert_eq!(pk.identity, key(&["b", "a"], None));
    assert_eq!(pk.read_only, None);

    let uniq = info(&mut session, "main", "uniq", ObjectKind::Table).await;
    assert_eq!(uniq.identity, key(&["y"], Some("uniq_y")));
    let total = uniq.columns.iter().find(|c| c.name == "total").unwrap();
    assert!(!total.writable);
    assert!(
        uniq.columns
            .iter()
            .find(|c| c.name == "x")
            .unwrap()
            .writable
    );

    let plain = info(&mut session, "main", "plain", ObjectKind::Table).await;
    assert_eq!(
        plain.identity,
        Some(RowIdentity::Rowid {
            rowid: "rowid".into()
        })
    );
    let shadow = info(&mut session, "main", "shadow", ObjectKind::Table).await;
    assert_eq!(
        shadow.identity,
        Some(RowIdentity::Rowid {
            rowid: "_rowid_".into()
        })
    );
    let every = info(&mut session, "main", "every", ObjectKind::Table).await;
    assert_eq!(every.identity, None);
    assert!(every.read_only.unwrap().contains("no primary key"));

    let nokey = info(&mut session, "main", "nokey", ObjectKind::Table).await;
    assert_eq!(nokey.identity, key(&["code"], None));

    let view = info(&mut session, "main", "v", ObjectKind::View).await;
    assert_eq!(view.identity, None);
    assert_eq!(view.read_only.as_deref(), Some("Views are read-only."));
    session.close().await;

    let mut ro = Session::open(sqlite_target(
        &dir.path().join("edit.db").display().to_string(),
        AccessLevel::Ro,
    ))
    .await
    .unwrap();
    let pk = info(&mut ro, "main", "pk", ObjectKind::Table).await;
    assert_eq!(pk.identity, None);
    assert_eq!(
        pk.read_only.as_deref(),
        Some("The connection is read-only (RO).")
    );
}

fn query(name: &str) -> TableQuery {
    TableQuery {
        schema: "main".into(),
        name: name.into(),
        filter: None,
        order: None,
    }
}

fn set(column: &str, text: &str) -> ColumnValue {
    ColumnValue {
        column: column.into(),
        value: NewValue::Text { text: text.into() },
    }
}

async fn load(session: &mut Session, name: &str, rowid: Option<&str>) {
    let sql = query(name)
        .page_sql(session.info().engine, Some("1"), rowid, 100, 0)
        .unwrap();
    session.table_page(&sql, rowid.is_some()).await.unwrap();
}

async fn texts(session: &mut Session, sql: &str) -> Vec<Vec<Option<String>>> {
    session
        .fetch_values(sql)
        .await
        .unwrap()
        .rows
        .into_iter()
        .map(|row| {
            row.into_iter()
                .map(crate::query::Value::into_text)
                .collect()
        })
        .collect()
}

#[tokio::test]
async fn sqlite_rowid_pages_keep_column_indexes() {
    let dir = tempfile::tempdir().unwrap();
    let mut session = sqlite_session(
        dir.path(),
        "CREATE TABLE shadow (rowid TEXT, note TEXT); INSERT INTO shadow VALUES ('r', 'a'), ('s', 'b');",
        AccessLevel::Rw,
    )
    .await;
    load(&mut session, "shadow", Some("_rowid_")).await;
    let page = session.page().unwrap();
    assert_eq!(page.columns.len(), 2);
    assert_eq!(page.columns[0].name, "rowid");
    assert_eq!(page.rows[1][0], crate::query::Value::Text("s".into()));
    assert_eq!(
        session.page_rowids,
        vec![
            crate::query::Value::Number("1".into()),
            crate::query::Value::Number("2".into())
        ]
    );
    assert!(
        query("shadow")
            .page_sql(Engine::Sqlite, None, Some("x; DROP TABLE t"), 1, 0)
            .is_err()
    );
    assert!(ROWID_ALIASES.contains(&"oid"));
}

fn items_batch(info: &EditInfo, changes: Vec<Change>) -> EditBatch {
    EditBatch {
        schema: "main".into(),
        name: "items".into(),
        identity: info.identity.clone().unwrap(),
        columns: info.columns.clone(),
        changes,
    }
}

const ITEMS: &str = r#"
    CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT NOT NULL, qty, data BLOB);
    INSERT INTO items (id, name, qty) VALUES (1, 'one', 1), (2, 'two', 2), (3, 'three', 3);
"#;

#[tokio::test]
async fn sqlite_applies_in_auto_mode() {
    let dir = tempfile::tempdir().unwrap();
    let mut session = sqlite_session(dir.path(), ITEMS, AccessLevel::Rw).await;
    session.set_transaction_mode(TransactionMode::Auto).unwrap();
    let info = info(&mut session, "main", "items", ObjectKind::Table).await;
    load(&mut session, "items", None).await;

    let file = dir.path().join("blob.bin");
    std::fs::write(&file, [0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]).unwrap();
    let staged = session.stage_file(&file).unwrap();
    assert_eq!(staged.size, 8);
    assert_eq!(staged.image, Some(crate::grid::ImageKind::Png));

    let batch = items_batch(
        &info,
        vec![
            Change::Update {
                row: 0,
                values: vec![
                    set("name", "uno"),
                    set("qty", "10"),
                    ColumnValue {
                        column: "data".into(),
                        value: NewValue::File {
                            token: staged.token,
                        },
                    },
                ],
            },
            Change::Delete { row: 2 },
            Change::Insert {
                values: vec![set("name", "four"), set("qty", "4")],
            },
        ],
    );
    let outcome = session.apply_edits(&batch, false).await.unwrap();
    assert_eq!(outcome.state, ApplyState::Committed);
    assert_eq!(outcome.statements.len(), 3);
    assert!(outcome.statements[0].sql.starts_with("DELETE"));
    assert!(!session.in_transaction());
    assert!(session.uploads.is_empty());

    assert_eq!(
        texts(
            &mut session,
            "SELECT id, name, typeof(qty), length(data) FROM items ORDER BY id"
        )
        .await,
        vec![
            vec![
                Some("1".into()),
                Some("uno".into()),
                Some("integer".into()),
                Some("8".into())
            ],
            vec![
                Some("2".into()),
                Some("two".into()),
                Some("integer".into()),
                None
            ],
            vec![
                Some("3".into()),
                Some("four".into()),
                Some("text".into()),
                None
            ],
        ]
    );

    // A failure rolls the whole batch back and points at its change.
    load(&mut session, "items", None).await;
    let batch = items_batch(
        &info,
        vec![
            Change::Update {
                row: 0,
                values: vec![set("name", "changed")],
            },
            Change::Insert {
                values: vec![set("id", "2"), set("name", "duplicate")],
            },
        ],
    );
    let failure = session.apply_edits(&batch, false).await.unwrap_err();
    assert_eq!(failure.change, Some(1));
    assert!(failure.sql.unwrap().starts_with("INSERT"));
    assert!(!session.in_transaction());
    assert_eq!(
        texts(&mut session, "SELECT name FROM items WHERE id = 1").await,
        vec![vec![Some("uno".into())]]
    );

    // A row deleted elsewhere matches nothing and fails the batch.
    load(&mut session, "items", None).await;
    session
        .execute("DELETE FROM items WHERE id = 2")
        .await
        .unwrap();
    let batch = items_batch(
        &info,
        vec![
            Change::Update {
                row: 0,
                values: vec![set("name", "again")],
            },
            Change::Update {
                row: 1,
                values: vec![set("name", "gone")],
            },
        ],
    );
    let failure = session.apply_edits(&batch, false).await.unwrap_err();
    assert_eq!(failure.change, Some(1));
    assert!(
        matches!(failure.error, RunError::Failed { ref message } if message.contains("changed or deleted"))
    );
    assert_eq!(
        texts(&mut session, "SELECT name FROM items WHERE id = 1").await,
        vec![vec![Some("uno".into())]]
    );

    // Confirm before commit leaves the transaction open with the statements.
    load(&mut session, "items", None).await;
    let batch = items_batch(
        &info,
        vec![Change::Update {
            row: 0,
            values: vec![set("name", "confirmed")],
        }],
    );
    let outcome = session.apply_edits(&batch, true).await.unwrap();
    assert_eq!(outcome.state, ApplyState::AwaitingConfirm);
    assert!(session.in_transaction());
    assert_eq!(session.transaction_statements().len(), 1);
    assert_eq!(session.transaction_statements()[0].rows_affected, Some(1));
    session.rollback().await.unwrap();
    assert_eq!(
        texts(&mut session, "SELECT name FROM items WHERE id = 1").await,
        vec![vec![Some("uno".into())]]
    );
}

#[tokio::test]
async fn sqlite_applies_in_manual_mode_under_a_savepoint() {
    let dir = tempfile::tempdir().unwrap();
    let mut session = sqlite_session(dir.path(), ITEMS, AccessLevel::Rw).await;
    session
        .set_transaction_mode(TransactionMode::Manual)
        .unwrap();
    let info = info(&mut session, "main", "items", ObjectKind::Table).await;
    load(&mut session, "items", None).await;

    let first = items_batch(
        &info,
        vec![Change::Update {
            row: 0,
            values: vec![set("name", "first")],
        }],
    );
    let outcome = session.apply_edits(&first, false).await.unwrap();
    assert_eq!(outcome.state, ApplyState::Applied);
    assert!(session.in_transaction());
    assert_eq!(session.transaction_statements().len(), 1);

    // A failing batch undoes only itself; the earlier work stays in the transaction.
    load(&mut session, "items", None).await;
    let failing = items_batch(
        &info,
        vec![
            Change::Update {
                row: 1,
                values: vec![set("name", "second")],
            },
            Change::Insert {
                values: vec![set("id", "3"), set("name", "duplicate")],
            },
        ],
    );
    assert!(session.apply_edits(&failing, false).await.is_err());
    assert!(session.in_transaction());
    assert_eq!(session.transaction_statements().len(), 1);
    assert_eq!(
        texts(&mut session, "SELECT name FROM items ORDER BY id LIMIT 2").await,
        vec![vec![Some("first".into())], vec![Some("two".into())]]
    );

    session.commit().await.unwrap();
    assert_eq!(
        texts(&mut session, "SELECT name FROM items WHERE id = 1").await,
        vec![vec![Some("first".into())]]
    );

    // A failure in a transaction the batch opened leaves no transaction behind.
    load(&mut session, "items", None).await;
    assert!(session.apply_edits(&failing, false).await.is_err());
    assert!(!session.in_transaction());
}

#[tokio::test]
async fn ro_sessions_refuse_edits() {
    let dir = tempfile::tempdir().unwrap();
    let mut rw = sqlite_session(dir.path(), ITEMS, AccessLevel::Rw).await;
    let info = info(&mut rw, "main", "items", ObjectKind::Table).await;
    rw.close().await;

    let path = dir.path().join("edit.db").display().to_string();
    let mut ro = Session::open(sqlite_target(&path, AccessLevel::Ro))
        .await
        .unwrap();
    ro.set_transaction_mode(TransactionMode::Auto).unwrap();
    load(&mut ro, "items", None).await;
    let failure = ro
        .apply_edits(
            &items_batch(
                &info,
                vec![Change::Update {
                    row: 0,
                    values: vec![set("name", "x")],
                }],
            ),
            false,
        )
        .await
        .unwrap_err();
    assert!(matches!(failure.error, RunError::Blocked { .. }));
    assert!(!ro.in_transaction());
}

mod postgres {
    use testcontainers::ImageExt;
    use testcontainers::runners::AsyncRunner;
    use testcontainers_modules::postgres::Postgres;

    use super::super::tests::postgres::{PASSWORD, pg_input, pg_target};
    use super::*;

    fn public(name: &str) -> TableQuery {
        TableQuery {
            schema: "public".into(),
            name: name.into(),
            filter: None,
            order: None,
        }
    }

    async fn load_pg(session: &mut Session, name: &str) {
        let sql = public(name)
            .page_sql(Engine::Postgres, Some("1"), None, 100, 0)
            .unwrap();
        session.table_page(&sql, false).await.unwrap();
    }

    #[tokio::test]
    async fn postgres_edits() {
        let container = match Postgres::default().with_tag("17-alpine").start().await {
            Ok(container) => container,
            Err(e) => {
                eprintln!("skipping PostgreSQL edit tests: Docker is not available ({e})");
                return;
            }
        };
        let port = container.get_host_port_ipv4(5432).await.unwrap();
        let mut session = Session::open(pg_target(&pg_input(port, AccessLevel::Ddl), PASSWORD))
            .await
            .unwrap();
        session
            .execute(
                r#"
                CREATE DOMAIN positive AS integer CHECK (VALUE > 0);
                CREATE TABLE products (
                    id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                    name text NOT NULL,
                    price numeric(10, 2),
                    stock positive,
                    note text DEFAULT 'none',
                    data bytea,
                    doubled integer GENERATED ALWAYS AS (stock * 2) STORED
                );
                INSERT INTO products (name, price, stock) VALUES ('a', 1, 1), ('b', 2, 2);
                CREATE TABLE keyed (code text NOT NULL, other text, maybe text);
                CREATE UNIQUE INDEX keyed_code ON keyed (code);
                CREATE UNIQUE INDEX keyed_maybe ON keyed (maybe);
                CREATE UNIQUE INDEX keyed_partial ON keyed (other) WHERE other IS NOT NULL;
                CREATE UNIQUE INDEX keyed_expr ON keyed (lower(other));
                CREATE TABLE loose (n integer);
                CREATE VIEW products_view AS SELECT * FROM products;
                "#,
            )
            .await
            .unwrap();

        let products = info(&mut session, "public", "products", ObjectKind::Table).await;
        assert_eq!(products.identity, key(&["id"], None));
        let column = |name: &str| products.columns.iter().find(|c| c.name == name).unwrap();
        assert!(!column("id").writable);
        assert_eq!(column("id").default_value.as_deref(), Some("identity"));
        assert!(!column("doubled").writable);
        assert_eq!(column("stock").type_name, "positive");
        assert_eq!(column("stock").base_type, "integer");
        assert_eq!(column("price").type_name, "numeric(10,2)");
        assert_eq!(
            column("note").default_value.as_deref(),
            Some("'none'::text")
        );

        let keyed = info(&mut session, "public", "keyed", ObjectKind::Table).await;
        assert_eq!(keyed.identity, key(&["code"], Some("keyed_code")));
        let loose = info(&mut session, "public", "loose", ObjectKind::Table).await;
        assert_eq!(loose.identity, None);
        let view = info(&mut session, "public", "products_view", ObjectKind::View).await;
        assert!(view.read_only.is_some());

        // Auto mode: one transaction; literals with quotes, backslashes, bytes, DEFAULT.
        session.set_transaction_mode(TransactionMode::Auto).unwrap();
        load_pg(&mut session, "products").await;
        let file = tempfile::NamedTempFile::new().unwrap();
        std::fs::write(file.path(), [0, 1, 0xff]).unwrap();
        let staged = session.stage_file(file.path()).unwrap();
        let batch = EditBatch {
            schema: "public".into(),
            name: "products".into(),
            identity: products.identity.clone().unwrap(),
            columns: products.columns.clone(),
            changes: vec![
                Change::Update {
                    row: 0,
                    values: vec![
                        set("name", "it's a \\ test"),
                        set("price", "12.50"),
                        ColumnValue {
                            column: "data".into(),
                            value: NewValue::File {
                                token: staged.token,
                            },
                        },
                    ],
                },
                Change::Update {
                    row: 1,
                    values: vec![ColumnValue {
                        column: "note".into(),
                        value: NewValue::Default,
                    }],
                },
                Change::Insert {
                    values: vec![set("name", "c"), set("stock", "3")],
                },
            ],
        };
        let outcome = session.apply_edits(&batch, false).await.unwrap();
        assert_eq!(outcome.state, ApplyState::Committed);
        let rows = texts(
            &mut session,
            "SELECT name, price::text, encode(data, 'hex'), note, doubled::text FROM products ORDER BY id",
        )
        .await;
        assert_eq!(
            rows[0],
            vec![
                Some("it's a \\ test".into()),
                Some("12.50".into()),
                Some("0001ff".into()),
                Some("none".into()),
                Some("2".into())
            ]
        );
        assert_eq!(rows[1][3].as_deref(), Some("none"));
        assert_eq!(rows[2][4].as_deref(), Some("6"));

        // A failing statement rolls everything back.
        load_pg(&mut session, "products").await;
        let failing = EditBatch {
            changes: vec![
                Change::Update {
                    row: 0,
                    values: vec![set("name", "rolled back")],
                },
                Change::Update {
                    row: 1,
                    values: vec![set("stock", "-1")],
                },
            ],
            ..batch.clone()
        };
        let failure = session.apply_edits(&failing, false).await.unwrap_err();
        assert_eq!(failure.change, Some(1));
        assert!(matches!(failure.error, RunError::Query { .. }));
        assert!(!session.in_transaction());

        // Manual mode: the savepoint recovers the aborted transaction and keeps earlier work.
        session
            .set_transaction_mode(TransactionMode::Manual)
            .unwrap();
        load_pg(&mut session, "products").await;
        let first = EditBatch {
            changes: vec![Change::Update {
                row: 2,
                values: vec![set("name", "kept")],
            }],
            ..batch.clone()
        };
        assert_eq!(
            session.apply_edits(&first, false).await.unwrap().state,
            ApplyState::Applied
        );
        load_pg(&mut session, "products").await;
        assert!(session.apply_edits(&failing, false).await.is_err());
        assert!(session.in_transaction());
        assert_eq!(session.transaction_statements().len(), 1);
        session.commit().await.unwrap();
        let rows = texts(&mut session, "SELECT name FROM products ORDER BY id").await;
        assert_eq!(rows[0][0].as_deref(), Some("it's a \\ test"));
        assert_eq!(rows[2][0].as_deref(), Some("kept"));

        // Table sessions read dates in ISO form.
        let style = texts(&mut session, "SHOW DateStyle").await;
        assert_eq!(style[0][0].as_deref(), Some("ISO, YMD"));
    }
}
