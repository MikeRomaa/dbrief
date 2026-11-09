//! SQLite catalogs: `sqlite_master` and the table-valued pragmas, for every database on the
//! connection (`main` and attached ones), and the structure and DDL of one object.

use super::{
    ConstraintInfo, IndexInfo, ObjectKind, ObjectRef, SchemaColumn, SchemaObject, Snapshot,
    TableStructure, TriggerInfo, not_found, quote_ident, quote_literal, records,
};
use crate::edit::{EditColumn, KeyCandidate};
use crate::session::{Session, SessionError};

pub(super) async fn load(session: &mut Session) -> Result<Snapshot, SessionError> {
    let databases = session
        .fetch_values("SELECT name FROM pragma_database_list WHERE name <> 'temp' ORDER BY seq")
        .await?;
    let databases: Vec<String> = records(&databases).map(|r| r.string("name")).collect();

    let mut snapshot = Snapshot::default();
    for db in databases {
        load_database(session, &db, &mut snapshot).await?;
    }
    Ok(snapshot)
}

async fn load_database(
    session: &mut Session,
    db: &str,
    snapshot: &mut Snapshot,
) -> Result<(), SessionError> {
    let master = format!("{}.sqlite_master", quote_ident(db));
    let objects = session
        .fetch_values(&format!(
            r#"
            SELECT
                type,
                name,
                tbl_name
            FROM
                {master}
            WHERE
                type IN ('table', 'view', 'index', 'trigger')
                AND name NOT LIKE 'sqlite\_%' ESCAPE '\'
            ORDER BY
                name
            "#
        ))
        .await?;

    let estimates = estimates(session, db).await;
    let sizes = sizes(session, db).await;

    let mut tables = Vec::new();
    for r in records(&objects) {
        let name = r.string("name");
        let kind = match r.string("type").as_str() {
            "table" => ObjectKind::Table,
            "view" => ObjectKind::View,
            "index" => ObjectKind::Index,
            _ => ObjectKind::Trigger,
        };
        let parent =
            matches!(kind, ObjectKind::Index | ObjectKind::Trigger).then(|| r.string("tbl_name"));
        if kind.has_rows() {
            tables.push(name.clone());
        }
        snapshot.objects.push(SchemaObject {
            schema: db.to_owned(),
            estimated_rows: estimates.get(&name).copied(),
            size_bytes: (kind == ObjectKind::Table)
                .then(|| sizes.get(&name).copied())
                .flatten(),
            name,
            kind,
            parent,
            detail: None,
        });
    }

    for table in tables {
        snapshot
            .columns
            .extend(table_columns(session, db, &table).await?);
    }
    Ok(())
}

/// Row counts from `sqlite_stat1`, which exists once `ANALYZE` has run. The first number of each
/// `stat` is the table's row count.
async fn estimates(session: &mut Session, db: &str) -> std::collections::HashMap<String, i64> {
    let sql = format!(
        "SELECT tbl, max(CAST(stat AS INTEGER)) AS row_count FROM {}.sqlite_stat1 GROUP BY tbl",
        quote_ident(db)
    );
    let Ok(values) = session.fetch_values(&sql).await else {
        return Default::default();
    };
    records(&values)
        .filter_map(|r| Some((r.text("tbl")?, r.int("row_count")?)))
        .collect()
}

/// Bytes used by each table and its indexes, from the `dbstat` virtual table.
async fn sizes(session: &mut Session, db: &str) -> std::collections::HashMap<String, i64> {
    let sql = format!(
        r#"
        SELECT
            m.tbl_name AS name,
            sum(s.pgsize) AS size
        FROM
            dbstat({}, 1) s
            JOIN {}.sqlite_master m ON m.name = s.name
        GROUP BY
            m.tbl_name
        "#,
        quote_literal(db),
        quote_ident(db)
    );
    let Ok(values) = session.fetch_values(&sql).await else {
        return Default::default();
    };
    records(&values)
        .filter_map(|r| Some((r.text("name")?, r.int("size")?)))
        .collect()
}

/// Columns of a table or view. Hidden columns of virtual tables are left out; generated columns stay.
async fn table_columns(
    session: &mut Session,
    db: &str,
    table: &str,
) -> Result<Vec<SchemaColumn>, SessionError> {
    let values = session
        .fetch_values(&format!(
            "SELECT cid, name, type, \"notnull\", dflt_value, pk, hidden FROM pragma_table_xinfo({}, {}) WHERE hidden <> 1 ORDER BY cid",
            quote_literal(table),
            quote_literal(db)
        ))
        .await?;
    Ok(records(&values)
        .map(|r| {
            let pk = r.int("pk").unwrap_or_default();
            SchemaColumn {
                schema: db.to_owned(),
                table_name: table.to_owned(),
                ordinal: r.int("cid").unwrap_or_default() as u32 + 1,
                name: r.string("name"),
                type_name: r.string("type"),
                nullable: !r.bool("notnull") && pk == 0,
                default_value: r.text("dflt_value"),
                pk_ordinal: (pk > 0).then_some(pk as u32),
            }
        })
        .collect())
}

pub(super) async fn structure(
    session: &mut Session,
    object: &ObjectRef,
) -> Result<TableStructure, SessionError> {
    let db = &object.schema;
    let table = &object.name;
    let columns = table_columns(session, db, table).await?;
    if columns.is_empty() {
        return Err(not_found(object));
    }

    let master = format!("{}.sqlite_master", quote_ident(db));
    let index_list = session
        .fetch_values(&format!(
            r#"
            SELECT
                l.name,
                l."unique",
                l.origin,
                m.sql
            FROM
                pragma_index_list({}, {}) l
                LEFT JOIN {master} m ON m.type = 'index'
                AND m.name = l.name
            ORDER BY
                l.origin = 'pk' DESC,
                l.name
            "#,
            quote_literal(table),
            quote_literal(db)
        ))
        .await?;

    let mut indexes = Vec::new();
    let mut constraints = Vec::new();
    let primary: Vec<&SchemaColumn> = {
        let mut pk: Vec<&SchemaColumn> =
            columns.iter().filter(|c| c.pk_ordinal.is_some()).collect();
        pk.sort_by_key(|c| c.pk_ordinal);
        pk
    };
    if !primary.is_empty() {
        constraints.push(ConstraintInfo {
            name: None,
            kind: "primary key".into(),
            definition: format!(
                "PRIMARY KEY ({})",
                primary
                    .iter()
                    .map(|c| quote_ident(&c.name))
                    .collect::<Vec<_>>()
                    .join(", ")
            ),
        });
    }

    for r in records(&index_list) {
        let name = r.string("name");
        let info = session
            .fetch_values(&format!(
                "SELECT name FROM pragma_index_info({}, {}) ORDER BY seqno",
                quote_literal(&name),
                quote_literal(db)
            ))
            .await?;
        let cols: Vec<String> = records(&info)
            .map(|c| c.text("name").unwrap_or_else(|| "<expression>".into()))
            .collect();
        let origin = r.string("origin");
        if origin == "u" {
            constraints.push(ConstraintInfo {
                name: None,
                kind: "unique".into(),
                definition: format!(
                    "UNIQUE ({})",
                    cols.iter()
                        .map(|c| quote_ident(c))
                        .collect::<Vec<_>>()
                        .join(", ")
                ),
            });
        }
        indexes.push(IndexInfo {
            name,
            columns: cols.join(", "),
            unique: r.bool("unique"),
            primary: origin == "pk",
            definition: r.text("sql"),
        });
    }

    let foreign = session
        .fetch_values(&format!(
            r#"
            SELECT
                id,
                "table",
                "from",
                "to",
                on_update,
                on_delete
            FROM
                pragma_foreign_key_list({}, {})
            ORDER BY
                id,
                seq
            "#,
            quote_literal(table),
            quote_literal(db)
        ))
        .await?;
    // One foreign key spans several rows (one per column), grouped by `id`.
    struct ForeignKey {
        id: i64,
        target: String,
        from: Vec<String>,
        to: Vec<String>,
        on_update: String,
        on_delete: String,
    }
    let mut keys: Vec<ForeignKey> = Vec::new();
    for r in records(&foreign) {
        let id = r.int("id").unwrap_or_default();
        if keys.last().is_none_or(|k| k.id != id) {
            keys.push(ForeignKey {
                id,
                target: r.string("table"),
                from: Vec::new(),
                to: Vec::new(),
                on_update: r.string("on_update"),
                on_delete: r.string("on_delete"),
            });
        }
        if let Some(key) = keys.last_mut() {
            key.from.push(quote_ident(&r.string("from")));
            if let Some(to) = r.text("to") {
                key.to.push(quote_ident(&to));
            }
        }
    }
    for key in keys {
        let mut definition = format!(
            "FOREIGN KEY ({}) REFERENCES {}",
            key.from.join(", "),
            quote_ident(&key.target)
        );
        if !key.to.is_empty() {
            definition.push_str(&format!(" ({})", key.to.join(", ")));
        }
        for (action, rule) in [("UPDATE", key.on_update), ("DELETE", key.on_delete)] {
            if rule != "NO ACTION" && !rule.is_empty() {
                definition.push_str(&format!(" ON {action} {rule}"));
            }
        }
        constraints.push(ConstraintInfo {
            name: None,
            kind: "foreign key".into(),
            definition,
        });
    }

    let trigger_rows = session
        .fetch_values(&format!(
            "SELECT name, sql FROM {master} WHERE type = 'trigger' AND tbl_name = {} ORDER BY name",
            quote_literal(table)
        ))
        .await?;
    let triggers = records(&trigger_rows)
        .map(|r| TriggerInfo {
            name: r.string("name"),
            enabled: true,
            definition: r.string("sql"),
        })
        .collect();

    Ok(TableStructure {
        columns,
        indexes,
        constraints,
        triggers,
    })
}

pub(super) async fn ddl(session: &mut Session, object: &ObjectRef) -> Result<String, SessionError> {
    let master = format!("{}.sqlite_master", quote_ident(&object.schema));
    let name = quote_literal(&object.name);
    // A table brings its indexes and triggers along; other objects are just their own statement.
    let sql = if object.kind == ObjectKind::Table {
        format!(
            r#"
            SELECT
                sql
            FROM
                {master}
            WHERE
                sql IS NOT NULL
                AND (
                    name = {name}
                    OR (type IN ('index', 'trigger') AND tbl_name = {name})
                )
            ORDER BY
                CASE type
                    WHEN 'table' THEN 0
                    WHEN 'index' THEN 1
                    ELSE 2
                END,
                name
            "#
        )
    } else {
        format!("SELECT sql FROM {master} WHERE name = {name} AND sql IS NOT NULL")
    };

    let values = session.fetch_values(&sql).await?;
    let statements: Vec<String> = records(&values)
        .map(|r| format!("{};\n", r.string("sql").trim_end().trim_end_matches(';')))
        .collect();
    if statements.is_empty() {
        return Err(not_found(object));
    }
    Ok(statements.join("\n"))
}

/// Columns and unique indexes of a table, for editing (see `edit`), and whether it is a rowid table
/// (not `WITHOUT ROWID`, not virtual).
pub(super) async fn edit_facts(
    session: &mut Session,
    object: &ObjectRef,
) -> Result<(Vec<EditColumn>, Vec<KeyCandidate>, bool), SessionError> {
    let db = quote_literal(&object.schema);
    let table = quote_literal(&object.name);

    let listed = session
        .fetch_values(&format!(
            "SELECT type, wr FROM pragma_table_list WHERE schema = {db} AND name = {table}"
        ))
        .await?;
    let rowid_table = records(&listed)
        .next()
        .is_some_and(|r| r.string("type") == "table" && r.int("wr") == Some(0));

    let values = session
        .fetch_values(&format!(
            "SELECT name, type, \"notnull\", dflt_value, pk, hidden FROM pragma_table_xinfo({table}, {db}) WHERE hidden <> 1 ORDER BY cid"
        ))
        .await?;
    let mut primary: Vec<(i64, String)> = Vec::new();
    let columns = records(&values)
        .map(|r| {
            let pk = r.int("pk").unwrap_or_default();
            let name = r.string("name");
            if pk > 0 {
                primary.push((pk, name.clone()));
            }
            let type_name = r.string("type");
            EditColumn {
                name,
                base_type: type_name.clone(),
                type_name,
                nullable: !r.bool("notnull") && pk == 0,
                default_value: r.text("dflt_value"),
                // 2 and 3 are generated columns (virtual and stored).
                writable: !matches!(r.int("hidden"), Some(2 | 3)),
            }
        })
        .collect();

    let mut candidates = Vec::new();
    if !primary.is_empty() {
        primary.sort();
        candidates.push(KeyCandidate {
            name: "primary key".into(),
            primary: true,
            partial: false,
            columns: Some(primary.into_iter().map(|(_, name)| name).collect()),
        });
    }

    let indexes = session
        .fetch_values(&format!(
            "SELECT name, partial FROM pragma_index_list({table}, {db}) WHERE \"unique\" = 1 AND origin <> 'pk'"
        ))
        .await?;
    for index in records(&indexes).collect::<Vec<_>>() {
        let name = index.string("name");
        let keys = session
            .fetch_values(&format!(
                "SELECT cid, name FROM pragma_index_xinfo({}, {db}) WHERE key = 1 ORDER BY seqno",
                quote_literal(&name)
            ))
            .await?;
        let mut columns = Vec::new();
        let mut expressions = false;
        for key in records(&keys) {
            if key.int("cid").unwrap_or(-2) < 0 {
                expressions = true;
            }
            columns.push(key.string("name"));
        }
        candidates.push(KeyCandidate {
            name,
            primary: false,
            partial: index.bool("partial"),
            columns: (!expressions).then_some(columns),
        });
    }

    Ok((columns, candidates, rowid_table))
}
