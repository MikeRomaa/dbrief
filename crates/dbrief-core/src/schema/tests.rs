//! Schema loading, structure, DDL and the cache. SQLite always; PostgreSQL needs Docker.

use std::path::Path;

use sqlx::Connection as _;
use sqlx::SqliteConnection;
use sqlx::sqlite::SqliteConnectOptions;
use uuid::Uuid;

use super::*;
use crate::connections::{AccessLevel, ConnectionInput, ConnectionRepo};
use crate::session::{ConnectTarget, Credentials};
use crate::ssh::SshEnv;
use crate::storage::Storage;

async fn sqlite_db(path: &Path, sql: &str) {
    let options = SqliteConnectOptions::new()
        .filename(path)
        .create_if_missing(true);
    let mut conn = SqliteConnection::connect_with(&options).await.unwrap();
    sqlx::raw_sql(sqlx::AssertSqlSafe(sql.to_owned()))
        .execute(&mut conn)
        .await
        .unwrap();
    conn.close().await.unwrap();
}

const SHOP: &str = r#"
    CREATE TABLE
        customers (id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT UNIQUE);
    CREATE TABLE
        orders (
            id INTEGER PRIMARY KEY,
            customer_id INTEGER NOT NULL REFERENCES customers (id) ON DELETE CASCADE,
            total REAL DEFAULT 0
        );
    CREATE INDEX
        orders_customer ON orders (customer_id);
    CREATE TABLE
        tags (code TEXT, label TEXT, PRIMARY KEY (code, label)) WITHOUT ROWID;
    CREATE TABLE
        notes (body TEXT);
    CREATE VIEW
        big_orders AS
    SELECT
        *
    FROM
        orders
    WHERE
        total > 100;
    CREATE TRIGGER
        orders_touch AFTER INSERT ON orders
    BEGIN
        SELECT 1;
    END;
    INSERT INTO
        customers (name)
    VALUES
        ('a'),
        ('b'),
        ('c');
"#;

async fn sqlite_session(dir: &Path, analyze: bool) -> Session {
    let main = dir.join("shop.db");
    sqlite_db(&main, SHOP).await;
    if analyze {
        sqlite_db(&main, "ANALYZE").await;
    }
    let other = dir.join("archive.db");
    sqlite_db(
        &other,
        "CREATE TABLE old_orders (id INTEGER PRIMARY KEY, total REAL);",
    )
    .await;

    let mut input = ConnectionInput::new("shop", Engine::Sqlite, AccessLevel::Rw);
    input.file_path = Some(main.display().to_string());
    input.startup_sql = Some(format!(
        "ATTACH DATABASE {} AS archive",
        quote_literal(&other.display().to_string())
    ));
    let target = ConnectTarget::new(
        Uuid::new_v4(),
        &input,
        &Credentials::default(),
        &SshEnv::new(Path::new("unused")),
    )
    .unwrap();
    Session::open(target).await.unwrap()
}

fn find<'a>(snapshot: &'a Snapshot, schema: &str, name: &str) -> &'a SchemaObject {
    snapshot
        .objects
        .iter()
        .find(|o| o.schema == schema && o.name == name)
        .unwrap_or_else(|| panic!("{schema}.{name} missing from {:#?}", snapshot.objects))
}

fn table(schema: &str, name: &str) -> ObjectRef {
    ObjectRef {
        schema: schema.into(),
        name: name.into(),
        kind: ObjectKind::Table,
        detail: None,
    }
}

#[tokio::test]
async fn sqlite_schema_loads_every_database() {
    let dir = tempfile::tempdir().unwrap();
    let mut session = sqlite_session(dir.path(), false).await;
    let snapshot = load(&mut session).await.unwrap();

    assert_eq!(find(&snapshot, "main", "customers").kind, ObjectKind::Table);
    assert_eq!(find(&snapshot, "main", "big_orders").kind, ObjectKind::View);
    let index = find(&snapshot, "main", "orders_customer");
    assert_eq!(index.kind, ObjectKind::Index);
    assert_eq!(index.parent.as_deref(), Some("orders"));
    assert_eq!(
        find(&snapshot, "main", "orders_touch").kind,
        ObjectKind::Trigger
    );
    assert_eq!(
        find(&snapshot, "archive", "old_orders").kind,
        ObjectKind::Table
    );
    assert!(
        !snapshot
            .objects
            .iter()
            .any(|o| o.name.starts_with("sqlite_")),
        "internal objects are hidden"
    );

    // No ANALYZE yet: no estimates. Sizes come from dbstat.
    let customers = find(&snapshot, "main", "customers");
    assert_eq!(customers.estimated_rows, None);
    assert!(customers.size_bytes.unwrap() > 0);

    let columns: Vec<&SchemaColumn> = snapshot
        .columns
        .iter()
        .filter(|c| c.table_name == "tags")
        .collect();
    assert_eq!(columns.len(), 2);
    assert_eq!(columns[0].pk_ordinal, Some(1));
    assert_eq!(columns[1].pk_ordinal, Some(2));
    assert!(!columns[0].nullable);

    let view_columns = snapshot
        .columns
        .iter()
        .filter(|c| c.table_name == "big_orders")
        .count();
    assert_eq!(view_columns, 3);
}

#[tokio::test]
async fn sqlite_estimates_come_from_analyze() {
    let dir = tempfile::tempdir().unwrap();
    let mut session = sqlite_session(dir.path(), true).await;
    let snapshot = load(&mut session).await.unwrap();
    assert_eq!(find(&snapshot, "main", "customers").estimated_rows, Some(3));
}

#[tokio::test]
async fn sqlite_structure_and_ddl() {
    let dir = tempfile::tempdir().unwrap();
    let mut session = sqlite_session(dir.path(), false).await;

    let orders = structure(&mut session, &table("main", "orders"))
        .await
        .unwrap();
    assert_eq!(orders.columns.len(), 3);
    assert_eq!(orders.columns[2].default_value.as_deref(), Some("0"));
    assert_eq!(orders.indexes.len(), 1);
    assert_eq!(orders.indexes[0].columns, "customer_id");
    assert!(orders.constraints.iter().any(|c| c.kind == "primary key"));
    let foreign = orders
        .constraints
        .iter()
        .find(|c| c.kind == "foreign key")
        .unwrap();
    assert_eq!(
        foreign.definition,
        "FOREIGN KEY (\"customer_id\") REFERENCES \"customers\" (\"id\") ON DELETE CASCADE"
    );
    assert_eq!(orders.triggers[0].name, "orders_touch");

    let customers = structure(&mut session, &table("main", "customers"))
        .await
        .unwrap();
    assert!(customers.constraints.iter().any(|c| c.kind == "unique"));

    let ddl = ddl(&mut session, &table("main", "orders")).await.unwrap();
    assert!(ddl.starts_with("CREATE TABLE"), "{ddl}");
    assert!(ddl.contains("orders_customer ON orders"), "{ddl}");
    assert!(ddl.contains("CREATE TRIGGER"), "{ddl}");

    let missing = structure(&mut session, &table("main", "nope")).await;
    assert!(missing.is_err());
}

async fn cache_with_connection() -> (tempfile::TempDir, SchemaCache, Uuid) {
    let dir = tempfile::tempdir().unwrap();
    let storage = Storage::open(dir.path()).await.unwrap();
    let repo = ConnectionRepo::new(storage.pool().clone());
    let mut input = ConnectionInput::new("shop", Engine::Sqlite, AccessLevel::Rw);
    input.file_path = Some("/tmp/shop.db".into());
    let id = repo.create_connection(input).await.unwrap().id;
    (dir, SchemaCache::new(storage.pool().clone()), id)
}

#[tokio::test]
async fn cache_replaces_reads_and_searches() {
    let dir = tempfile::tempdir().unwrap();
    let mut session = sqlite_session(dir.path(), false).await;
    let snapshot = load(&mut session).await.unwrap();

    let (_store, cache, id) = cache_with_connection().await;
    assert_eq!(cache.refreshed_at(id).await.unwrap(), None);
    cache.replace(id, &snapshot).await.unwrap();
    // Replacing again doesn't duplicate anything.
    cache.replace(id, &snapshot).await.unwrap();
    assert!(cache.refreshed_at(id).await.unwrap().is_some());

    let objects = cache.objects(id).await.unwrap();
    assert_eq!(objects.len(), snapshot.objects.len());
    let columns = cache.columns(id, "main", "orders").await.unwrap();
    assert_eq!(
        columns.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(),
        ["id", "customer_id", "total"]
    );
    assert_eq!(columns[0].pk_ordinal, Some(1));

    let hits = cache.search("ord", 10).await.unwrap();
    let tables: Vec<&str> = hits
        .iter()
        .filter(|h| h.kind == SearchKind::Table)
        .map(|h| h.table.as_str())
        .collect();
    assert_eq!(tables[0], "orders", "prefix matches first: {tables:?}");
    assert!(tables.contains(&"old_orders"));

    let hits = cache.search("orders.cust", 10).await.unwrap();
    assert_eq!(hits[0].kind, SearchKind::Column);
    assert_eq!(hits[0].table, "orders", "{hits:?}");
    assert_eq!(hits[0].column.as_deref(), Some("customer_id"));
    assert!(hits.iter().all(|h| h.table.contains("orders")), "{hits:?}");

    // `_` in the query is a literal underscore, not a LIKE wildcard.
    let hits = cache.search("o_o", 10).await.unwrap();
    assert!(hits.iter().all(|h| h.table.contains('_')), "{hits:?}");

    assert_eq!(cache.layout(id, "main", "orders").await.unwrap(), None);
    cache
        .set_layout(id, "main", "orders", "{\"a\":1}")
        .await
        .unwrap();
    cache
        .set_layout(id, "main", "orders", "{\"a\":2}")
        .await
        .unwrap();
    assert_eq!(
        cache.layout(id, "main", "orders").await.unwrap().as_deref(),
        Some("{\"a\":2}")
    );
}

#[test]
fn fuzzy_scores_prefer_exact_prefix_and_word_starts() {
    assert_eq!(fuzzy_score("x", "abc"), None);
    assert!(fuzzy_score("orders", "orders") > fuzzy_score("orders", "orders_archive"));
    assert!(fuzzy_score("ord", "orders") > fuzzy_score("ord", "old_orders"));
    assert!(fuzzy_score("co", "customer_orders") > fuzzy_score("co", "discount"));
    assert!(fuzzy_score("ci", "customerId").is_some());
    assert_eq!(fuzzy_score("", "anything"), Some(0));
}

mod postgres {
    use testcontainers::ImageExt;
    use testcontainers::runners::AsyncRunner;
    use testcontainers_modules::postgres::Postgres;

    use super::*;

    const SETUP: &str = r#"
        CREATE SCHEMA
            shop;
        CREATE SCHEMA
            empty;
        CREATE TABLE
            shop.customers (
                id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                name text NOT NULL,
                email varchar(200) UNIQUE,
                created timestamptz NOT NULL DEFAULT now()
            );
        CREATE TABLE
            shop.orders (
                id serial,
                customer_id bigint NOT NULL REFERENCES shop.customers (id) ON DELETE CASCADE,
                total numeric(10, 2) CHECK (total >= 0),
                doubled numeric GENERATED ALWAYS AS (total * 2) STORED,
                PRIMARY KEY (id)
            );
        CREATE INDEX
            orders_customer ON shop.orders (customer_id) WHERE total > 0;
        CREATE TABLE
            shop.events (at date NOT NULL, kind text) PARTITION BY RANGE (at);
        CREATE TABLE
            shop.events_2026 PARTITION OF shop.events FOR VALUES FROM ('2026-01-01') TO ('2027-01-01');
        CREATE VIEW
            shop.big_orders AS
        SELECT
            id,
            total
        FROM
            shop.orders
        WHERE
            total > 100;
        CREATE MATERIALIZED VIEW
            shop.totals AS
        SELECT
            customer_id,
            sum(total) AS total
        FROM
            shop.orders
        GROUP BY
            customer_id;
        CREATE SEQUENCE
            shop.ticket START 100 INCREMENT 5;
        CREATE FUNCTION
            shop.add (a int, b int) RETURNS int LANGUAGE sql AS 'SELECT a + b';
        CREATE FUNCTION
            shop.add (a text, b text) RETURNS text LANGUAGE sql AS 'SELECT a || b';
        CREATE FUNCTION
            shop.touch () RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;
        CREATE TRIGGER
            orders_touch BEFORE INSERT ON shop.orders FOR EACH ROW EXECUTE FUNCTION shop.touch ();
        INSERT INTO
            shop.customers (name)
        VALUES
            ('a'),
            ('b');
        ANALYZE shop.customers;
    "#;

    #[tokio::test]
    async fn postgres_schema() {
        let container = match Postgres::default().with_tag("17-alpine").start().await {
            Ok(container) => container,
            Err(e) => {
                eprintln!("skipping PostgreSQL schema tests: Docker is not available ({e})");
                return;
            }
        };
        let port = container.get_host_port_ipv4(5432).await.unwrap();

        let mut input = ConnectionInput::new("pg", Engine::Postgres, AccessLevel::Ddl);
        input.host = Some("127.0.0.1".into());
        input.port = Some(port);
        input.username = Some("postgres".into());
        input.database = Some("postgres".into());
        let target = ConnectTarget::new(
            Uuid::new_v4(),
            &input,
            &Credentials::password("postgres"),
            &SshEnv::new(Path::new("unused")),
        )
        .unwrap();
        let mut session = Session::open(target).await.unwrap();
        session.execute(SETUP).await.unwrap();

        let snapshot = load(&mut session).await.unwrap();
        assert_eq!(find(&snapshot, "empty", "empty").kind, ObjectKind::Schema);
        assert!(
            !snapshot.objects.iter().any(|o| o.schema == "pg_catalog"),
            "system schemas are hidden"
        );
        let customers = find(&snapshot, "shop", "customers");
        assert_eq!(customers.kind, ObjectKind::Table);
        assert_eq!(customers.estimated_rows, Some(2));
        assert!(customers.size_bytes.unwrap() > 0);
        // Never analyzed: no estimate.
        assert_eq!(find(&snapshot, "shop", "orders").estimated_rows, None);
        assert_eq!(find(&snapshot, "shop", "events").kind, ObjectKind::Table);
        assert_eq!(find(&snapshot, "shop", "big_orders").kind, ObjectKind::View);
        assert_eq!(
            find(&snapshot, "shop", "totals").kind,
            ObjectKind::MaterializedView
        );
        assert_eq!(find(&snapshot, "shop", "ticket").kind, ObjectKind::Sequence);
        let adds: Vec<&str> = snapshot
            .objects
            .iter()
            .filter(|o| o.name == "add")
            .filter_map(|o| o.detail.as_deref())
            .collect();
        assert_eq!(adds, ["a integer, b integer", "a text, b text"]);

        let order_columns: Vec<&SchemaColumn> = snapshot
            .columns
            .iter()
            .filter(|c| c.schema == "shop" && c.table_name == "orders")
            .collect();
        assert_eq!(order_columns.len(), 4);
        assert_eq!(order_columns[0].pk_ordinal, Some(1));
        assert_eq!(order_columns[2].type_name, "numeric(10,2)");

        // Structure.
        let orders = table("shop", "orders");
        let structure = structure(&mut session, &orders).await.unwrap();
        assert_eq!(
            structure.columns[3].default_value.as_deref(),
            Some("GENERATED ALWAYS AS ((total * (2)::numeric)) STORED")
        );
        assert_eq!(structure.indexes.len(), 2);
        assert!(structure.indexes[0].primary);
        assert_eq!(structure.indexes[1].columns, "customer_id");
        let kinds: Vec<&str> = structure
            .constraints
            .iter()
            .map(|c| c.kind.as_str())
            .collect();
        assert_eq!(kinds, ["primary key", "foreign key", "check"]);
        assert_eq!(structure.triggers.len(), 1);

        // bytea arrives as hex text and is decoded; JPEGs are recognized.
        session
            .execute("CREATE TABLE shop.blobs (id int PRIMARY KEY, data bytea); INSERT INTO shop.blobs VALUES (1, '\\xffd8ffe000'::bytea)")
            .await
            .unwrap();
        let blobs = crate::grid::TableQuery {
            schema: "shop".into(),
            name: "blobs".into(),
            filter: None,
            order: None,
        };
        let sql = blobs.page_sql(Engine::Postgres, None, None, 10, 0).unwrap();
        let page = session.table_page(&sql, false).await.unwrap();
        assert_eq!(
            page.cells[0][1],
            Some(crate::grid::Cell::Binary {
                binary: 5,
                image: Some(crate::grid::ImageKind::Jpeg)
            })
        );

        for (kind, name, detail, starts) in [
            (
                ObjectKind::View,
                "big_orders",
                None,
                "CREATE VIEW \"shop\".\"big_orders\" AS",
            ),
            (
                ObjectKind::Sequence,
                "ticket",
                None,
                "CREATE SEQUENCE \"shop\".\"ticket\"",
            ),
            (
                ObjectKind::Function,
                "add",
                Some("a text, b text"),
                "CREATE OR REPLACE FUNCTION shop.add(a text, b text)",
            ),
        ] {
            let object = ObjectRef {
                schema: "shop".into(),
                name: name.into(),
                kind,
                detail: detail.map(Into::into),
            };
            let text = ddl(&mut session, &object).await.unwrap();
            assert!(text.starts_with(starts), "{text}");
        }

        // DDL recreates the same objects: generate, drop, run the DDL, and compare.
        let mut generated = Vec::new();
        for name in ["customers", "orders", "events"] {
            generated.push(ddl(&mut session, &table("shop", name)).await.unwrap());
        }
        let before = structure_of(&mut session).await;
        session
            .execute("DROP TABLE shop.events; DROP TABLE shop.orders CASCADE; DROP TABLE shop.customers CASCADE;")
            .await
            .unwrap();
        for sql in &generated {
            session
                .execute(sql)
                .await
                .unwrap_or_else(|e| panic!("{e}\n{sql}"));
        }
        assert_eq!(structure_of(&mut session).await, before);
    }

    /// Columns, indexes, constraints and triggers of the recreated tables, for comparing.
    async fn structure_of(session: &mut Session) -> Vec<TableStructure> {
        let mut all = Vec::new();
        for name in ["customers", "orders", "events"] {
            all.push(structure(session, &table("shop", name)).await.unwrap());
        }
        all
    }
}

#[tokio::test]
async fn sqlite_table_pages_keep_full_values() {
    use crate::grid::{Cell, FullValue, ImageKind, TableQuery, default_order};

    let dir = tempfile::tempdir().unwrap();
    let mut session = sqlite_session(dir.path(), false).await;
    session
        .execute(
            r#"
            CREATE TABLE
                files (id INTEGER PRIMARY KEY, name TEXT, data BLOB);
            INSERT INTO
                files (name, data)
            VALUES
                ('logo', x'89504e470d0a1a0a0000'),
                ('long', NULL);
            UPDATE
                files
            SET
                name = printf('%.2000c', 'x')
            WHERE
                id = 2;
            "#,
        )
        .await
        .unwrap();

    let snapshot = load(&mut session).await.unwrap();
    let columns: Vec<SchemaColumn> = snapshot
        .columns
        .into_iter()
        .filter(|c| c.table_name == "files")
        .collect();
    let order = default_order(Engine::Sqlite, ObjectKind::Table, &columns);
    let query = TableQuery {
        schema: "main".into(),
        name: "files".into(),
        filter: None,
        order: None,
    };
    let sql = query
        .page_sql(Engine::Sqlite, order.as_deref(), None, 1, 0)
        .unwrap();
    let page = session.table_page(&sql, false).await.unwrap();
    assert_eq!(page.cells.len(), 1);
    assert_eq!(
        page.cells[0][2],
        Some(Cell::Binary {
            binary: 10,
            image: Some(ImageKind::Png)
        })
    );
    let full = FullValue::of(session.page_value(0, 2).unwrap());
    assert!(full.image.unwrap().starts_with("data:image/png;base64,"));

    // The second page: long text is cut in the cell and whole in the page.
    let sql = query
        .page_sql(Engine::Sqlite, order.as_deref(), None, 1, 1)
        .unwrap();
    let page = session.table_page(&sql, false).await.unwrap();
    assert!(matches!(
        &page.cells[0][1],
        Some(Cell::Cut { length: 2000, .. })
    ));
    assert_eq!(page.cells[0][2], None);
    assert_eq!(
        session.page_value(0, 1).unwrap().as_text().map(str::len),
        Some(2000)
    );

    // An empty page still has its columns.
    let empty = TableQuery {
        filter: Some("id > 100".into()),
        ..query.clone()
    };
    let sql = empty.page_sql(Engine::Sqlite, None, None, 10, 0).unwrap();
    let page = session.table_page(&sql, false).await.unwrap();
    assert!(page.cells.is_empty());
    assert_eq!(page.columns.len(), 3);

    // Counts follow the filter; a bad filter is the database's error.
    let count = session
        .fetch_values(&empty.count_sql(Engine::Sqlite).unwrap())
        .await
        .unwrap();
    assert_eq!(count.rows[0][0].as_i64(), Some(0));
    let broken = TableQuery {
        filter: Some("nope = 1".into()),
        ..query
    };
    let sql = broken.page_sql(Engine::Sqlite, None, None, 10, 0).unwrap();
    assert!(matches!(
        session.table_page(&sql, false).await,
        Err(SessionError::Query(_))
    ));
}
