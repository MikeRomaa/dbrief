//! PostgreSQL catalogs: the schema of the connected database in a few bulk queries, and the
//! structure and DDL of one object.

use super::{
    ConstraintInfo, IndexInfo, ObjectKind, ObjectRef, SchemaColumn, SchemaObject, Snapshot,
    TableStructure, TriggerInfo, not_found, qualified, quote_ident, quote_literal, records,
};
use crate::session::{Session, SessionError};

/// Schemas that hold the system catalogs, TOAST data and other sessions' temporary tables.
const USER_SCHEMAS: &str = r#"
    n.nspname NOT IN ('pg_catalog', 'information_schema')
    AND n.nspname NOT LIKE 'pg\_toast%'
    AND n.nspname NOT LIKE 'pg\_temp\_%'
"#;

pub(super) async fn load(session: &mut Session) -> Result<Snapshot, SessionError> {
    let mut snapshot = Snapshot::default();

    let schemas = session
        .fetch_values(&format!(
            r#"
            SELECT
                n.nspname AS schema
            FROM
                pg_namespace n
            WHERE
                {USER_SCHEMAS}
            ORDER BY
                1
            "#
        ))
        .await?;
    for r in records(&schemas) {
        snapshot.objects.push(SchemaObject {
            schema: r.string("schema"),
            name: r.string("schema"),
            kind: ObjectKind::Schema,
            parent: None,
            detail: None,
            estimated_rows: None,
            size_bytes: None,
        });
    }

    // reltuples is -1 for a table that was never vacuumed or analyzed: no estimate.
    let relations = session
        .fetch_values(&format!(
            r#"
            SELECT
                n.nspname AS schema,
                c.relname AS name,
                c.relkind AS relkind,
                CASE
                    WHEN c.reltuples < 0 THEN NULL
                    ELSE c.reltuples::bigint
                END AS estimated_rows,
                CASE
                    WHEN c.relkind IN ('r', 'm', 'p') THEN pg_total_relation_size(c.oid)
                END AS size_bytes
            FROM
                pg_class c
                JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE
                c.relkind IN ('r', 'p', 'f', 'v', 'm', 'S')
                AND {USER_SCHEMAS}
            ORDER BY
                1,
                2
            "#
        ))
        .await?;
    for r in records(&relations) {
        let kind = match r.string("relkind").as_str() {
            "v" => ObjectKind::View,
            "m" => ObjectKind::MaterializedView,
            "S" => ObjectKind::Sequence,
            _ => ObjectKind::Table,
        };
        let rows = kind != ObjectKind::Sequence && kind != ObjectKind::View;
        snapshot.objects.push(SchemaObject {
            schema: r.string("schema"),
            name: r.string("name"),
            kind,
            parent: None,
            detail: None,
            estimated_rows: r.whole("estimated_rows").filter(|_| rows),
            size_bytes: r.int("size_bytes"),
        });
    }

    // Functions that belong to extensions are left out: some extensions bring thousands.
    let functions = session
        .fetch_values(&format!(
            r#"
            SELECT
                n.nspname AS schema,
                p.proname AS name,
                pg_get_function_identity_arguments(p.oid) AS arguments
            FROM
                pg_proc p
                JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE
                p.prokind IN ('f', 'p')
                AND {USER_SCHEMAS}
                AND NOT EXISTS (
                    SELECT
                        1
                    FROM
                        pg_depend d
                    WHERE
                        d.classid = 'pg_proc'::regclass
                        AND d.objid = p.oid
                        AND d.deptype = 'e'
                )
            ORDER BY
                1,
                2,
                3
            "#
        ))
        .await?;
    for r in records(&functions) {
        let arguments = r.string("arguments");
        snapshot.objects.push(SchemaObject {
            schema: r.string("schema"),
            name: r.string("name"),
            kind: ObjectKind::Function,
            parent: None,
            detail: Some(arguments),
            estimated_rows: None,
            size_bytes: None,
        });
    }

    let columns = session
        .fetch_values(&format!(
            r#"
            SELECT
                n.nspname AS schema,
                c.relname AS table_name,
                a.attnum AS ordinal,
                a.attname AS name,
                format_type(a.atttypid, a.atttypmod) AS type_name,
                NOT a.attnotnull AS nullable,
                pg_get_expr(d.adbin, d.adrelid) AS default_value,
                (
                    SELECT
                        k.n
                    FROM
                        pg_index i,
                        unnest(i.indkey) WITH ORDINALITY AS k (attnum, n)
                    WHERE
                        i.indrelid = c.oid
                        AND i.indisprimary
                        AND k.attnum = a.attnum
                ) AS pk_ordinal
            FROM
                pg_attribute a
                JOIN pg_class c ON c.oid = a.attrelid
                JOIN pg_namespace n ON n.oid = c.relnamespace
                LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid
                AND d.adnum = a.attnum
            WHERE
                a.attnum > 0
                AND NOT a.attisdropped
                AND c.relkind IN ('r', 'p', 'f', 'v', 'm')
                AND {USER_SCHEMAS}
            ORDER BY
                1,
                2,
                3
            "#
        ))
        .await?;
    snapshot.columns = records(&columns)
        .map(|r| SchemaColumn {
            schema: r.string("schema"),
            table_name: r.string("table_name"),
            ordinal: r.int("ordinal").unwrap_or_default() as u32,
            name: r.string("name"),
            type_name: r.string("type_name"),
            nullable: r.bool("nullable"),
            default_value: r.text("default_value"),
            pk_ordinal: r.int("pk_ordinal").map(|n| n as u32),
        })
        .collect();

    Ok(snapshot)
}

/// The oid of a relation, as a subquery.
fn relation_oid(schema: &str, name: &str) -> String {
    format!(
        r#"(
            SELECT
                c.oid
            FROM
                pg_class c
                JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE
                n.nspname = {}
                AND c.relname = {}
        )"#,
        quote_literal(schema),
        quote_literal(name)
    )
}

async fn columns(
    session: &mut Session,
    object: &ObjectRef,
) -> Result<Vec<SchemaColumn>, SessionError> {
    let oid = relation_oid(&object.schema, &object.name);
    let values = session
        .fetch_values(&format!(
            r#"
            SELECT
                a.attnum AS ordinal,
                a.attname AS name,
                format_type(a.atttypid, a.atttypmod) AS type_name,
                NOT a.attnotnull AS nullable,
                pg_get_expr(d.adbin, d.adrelid) AS default_value,
                a.attidentity AS identity,
                a.attgenerated AS generated,
                (
                    SELECT
                        k.n
                    FROM
                        pg_index i,
                        unnest(i.indkey) WITH ORDINALITY AS k (attnum, n)
                    WHERE
                        i.indrelid = a.attrelid
                        AND i.indisprimary
                        AND k.attnum = a.attnum
                ) AS pk_ordinal
            FROM
                pg_attribute a
                LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid
                AND d.adnum = a.attnum
            WHERE
                a.attrelid = {oid}
                AND a.attnum > 0
                AND NOT a.attisdropped
            ORDER BY
                a.attnum
            "#
        ))
        .await?;

    Ok(records(&values)
        .map(|r| {
            // Identity and generated columns show how they are filled in place of a default.
            let default_value = match (
                r.string("identity").as_str(),
                r.string("generated").as_str(),
            ) {
                ("a", _) => Some("GENERATED ALWAYS AS IDENTITY".to_owned()),
                ("d", _) => Some("GENERATED BY DEFAULT AS IDENTITY".to_owned()),
                (_, "s") => r
                    .text("default_value")
                    .map(|e| format!("GENERATED ALWAYS AS ({e}) STORED")),
                (_, "v") => r
                    .text("default_value")
                    .map(|e| format!("GENERATED ALWAYS AS ({e}) VIRTUAL")),
                _ => r.text("default_value"),
            };
            SchemaColumn {
                schema: object.schema.clone(),
                table_name: object.name.clone(),
                ordinal: r.int("ordinal").unwrap_or_default() as u32,
                name: r.string("name"),
                type_name: r.string("type_name"),
                nullable: r.bool("nullable"),
                default_value,
                pk_ordinal: r.int("pk_ordinal").map(|n| n as u32),
            }
        })
        .collect())
}

pub(super) async fn structure(
    session: &mut Session,
    object: &ObjectRef,
) -> Result<TableStructure, SessionError> {
    let columns = columns(session, object).await?;
    if columns.is_empty() && !exists(session, object).await? {
        return Err(not_found(object));
    }
    let oid = relation_oid(&object.schema, &object.name);

    let indexes = session
        .fetch_values(&format!(
            r#"
            SELECT
                i.relname AS name,
                x.indisunique AS is_unique,
                x.indisprimary AS is_primary,
                pg_get_indexdef(x.indexrelid) AS definition,
                array_to_string(
                    ARRAY(
                        SELECT
                            pg_get_indexdef(x.indexrelid, k, TRUE)
                        FROM
                            generate_series(1, x.indnkeyatts) AS k
                        ORDER BY
                            k
                    ),
                    ', '
                ) AS columns
            FROM
                pg_index x
                JOIN pg_class i ON i.oid = x.indexrelid
            WHERE
                x.indrelid = {oid}
            ORDER BY
                x.indisprimary DESC,
                i.relname
            "#
        ))
        .await?;
    let indexes = records(&indexes)
        .map(|r| IndexInfo {
            name: r.string("name"),
            columns: r.string("columns"),
            unique: r.bool("is_unique"),
            primary: r.bool("is_primary"),
            definition: r.text("definition"),
        })
        .collect();

    let constraints = session
        .fetch_values(&format!(
            r#"
            SELECT
                conname AS name,
                contype AS kind,
                pg_get_constraintdef(oid, TRUE) AS definition
            FROM
                pg_constraint
            WHERE
                conrelid = {oid}
                AND contype IN ('p', 'u', 'f', 'c', 'x')
            ORDER BY
                position(contype IN 'pufcx'),
                conname
            "#
        ))
        .await?;
    let constraints = records(&constraints)
        .map(|r| ConstraintInfo {
            name: r.text("name"),
            kind: constraint_kind(&r.string("kind")).to_owned(),
            definition: r.string("definition"),
        })
        .collect();

    let triggers = session
        .fetch_values(&format!(
            r#"
            SELECT
                tgname AS name,
                tgenabled <> 'D' AS enabled,
                pg_get_triggerdef(oid, TRUE) AS definition
            FROM
                pg_trigger
            WHERE
                tgrelid = {oid}
                AND NOT tgisinternal
            ORDER BY
                tgname
            "#
        ))
        .await?;
    let triggers = records(&triggers)
        .map(|r| TriggerInfo {
            name: r.string("name"),
            enabled: r.bool("enabled"),
            definition: r.string("definition"),
        })
        .collect();

    Ok(TableStructure {
        columns,
        indexes,
        constraints,
        triggers,
    })
}

fn constraint_kind(contype: &str) -> &'static str {
    match contype {
        "p" => "primary key",
        "u" => "unique",
        "f" => "foreign key",
        "c" => "check",
        _ => "exclusion",
    }
}

async fn exists(session: &mut Session, object: &ObjectRef) -> Result<bool, SessionError> {
    let values = session
        .fetch_values(&format!(
            "SELECT {} IS NOT NULL AS found",
            relation_oid(&object.schema, &object.name)
        ))
        .await?;
    Ok(records(&values).next().is_some_and(|r| r.bool("found")))
}

/// One text value, or `None` when the query returned no rows or NULL.
async fn scalar(session: &mut Session, sql: &str) -> Result<Option<String>, SessionError> {
    let values = session.fetch_values(sql).await?;
    Ok(values
        .rows
        .into_iter()
        .next()
        .and_then(|row| row.into_iter().next())
        .and_then(crate::query::Value::into_text))
}

pub(super) async fn ddl(session: &mut Session, object: &ObjectRef) -> Result<String, SessionError> {
    let name = qualified(&object.schema, &object.name);
    let oid = relation_oid(&object.schema, &object.name);
    match object.kind {
        ObjectKind::Schema => Ok(format!("CREATE SCHEMA {};\n", quote_ident(&object.name))),
        ObjectKind::Table => table_ddl(session, object).await,
        ObjectKind::View => {
            let body = scalar(session, &format!("SELECT pg_get_viewdef({oid}, TRUE)"))
                .await?
                .ok_or_else(|| not_found(object))?;
            Ok(format!(
                "CREATE VIEW {name} AS\n{}\n",
                with_semicolon(&body)
            ))
        }
        ObjectKind::MaterializedView => {
            let body = scalar(session, &format!("SELECT pg_get_viewdef({oid}, TRUE)"))
                .await?
                .ok_or_else(|| not_found(object))?;
            let mut ddl = format!(
                "CREATE MATERIALIZED VIEW {name} AS\n{}\n",
                with_semicolon(&body)
            );
            for index in index_definitions(session, &oid).await? {
                ddl.push_str(&format!("\n{index};\n"));
            }
            Ok(ddl)
        }
        ObjectKind::Function => {
            let arguments = object.detail.clone().unwrap_or_default();
            let sql = format!(
                r#"
                SELECT
                    pg_get_functiondef(p.oid)
                FROM
                    pg_proc p
                    JOIN pg_namespace n ON n.oid = p.pronamespace
                WHERE
                    n.nspname = {}
                    AND p.proname = {}
                    AND pg_get_function_identity_arguments(p.oid) = {}
                "#,
                quote_literal(&object.schema),
                quote_literal(&object.name),
                quote_literal(&arguments)
            );
            let body = scalar(session, &sql)
                .await?
                .ok_or_else(|| not_found(object))?;
            Ok(format!("{};\n", body.trim_end()))
        }
        ObjectKind::Sequence => sequence_ddl(session, object).await,
        ObjectKind::Index => scalar(
            session,
            &format!("SELECT pg_get_indexdef({oid}) || ';' || chr(10)"),
        )
        .await?
        .ok_or_else(|| not_found(object)),
        ObjectKind::Trigger => scalar(
            session,
            &format!(
                r#"
                SELECT
                    pg_get_triggerdef(t.oid, TRUE) || ';' || chr(10)
                FROM
                    pg_trigger t
                    JOIN pg_class c ON c.oid = t.tgrelid
                    JOIN pg_namespace n ON n.oid = c.relnamespace
                WHERE
                    n.nspname = {}
                    AND t.tgname = {}
                LIMIT
                    1
                "#,
                quote_literal(&object.schema),
                quote_literal(&object.name)
            ),
        )
        .await?
        .ok_or_else(|| not_found(object)),
    }
}

async fn sequence_ddl(session: &mut Session, object: &ObjectRef) -> Result<String, SessionError> {
    let name = qualified(&object.schema, &object.name);
    let oid = relation_oid(&object.schema, &object.name);
    let values = session
        .fetch_values(&format!(
            r#"
            SELECT
                format_type(seqtypid, NULL) AS type_name,
                seqincrement AS increment,
                seqmin AS min,
                seqmax AS max,
                seqstart AS start,
                seqcache AS cache,
                seqcycle AS cycle
            FROM
                pg_sequence
            WHERE
                seqrelid = {oid}
            "#
        ))
        .await?;
    let r = records(&values).next().ok_or_else(|| not_found(object))?;
    Ok(format!(
        "CREATE SEQUENCE {name}\n    AS {}\n    INCREMENT BY {}\n    MINVALUE {}\n    MAXVALUE {}\n    START WITH {}\n    CACHE {}{};\n",
        r.string("type_name"),
        r.string("increment"),
        r.string("min"),
        r.string("max"),
        r.string("start"),
        r.string("cache"),
        if r.bool("cycle") { "\n    CYCLE" } else { "" }
    ))
}

/// Sequences owned by the table's columns (`serial`), as `(sequence, column)`. Identity columns own
/// theirs differently and recreate them on their own.
async fn owned_sequences(
    session: &mut Session,
    oid: &str,
) -> Result<Vec<(String, String, String)>, SessionError> {
    let values = session
        .fetch_values(&format!(
            r#"
            SELECT
                n.nspname AS schema,
                s.relname AS name,
                a.attname AS column_name
            FROM
                pg_depend d
                JOIN pg_class s ON s.oid = d.objid
                AND s.relkind = 'S'
                JOIN pg_namespace n ON n.oid = s.relnamespace
                JOIN pg_attribute a ON a.attrelid = d.refobjid
                AND a.attnum = d.refobjsubid
            WHERE
                d.classid = 'pg_class'::regclass
                AND d.refobjid = {oid}
                AND d.deptype = 'a'
            ORDER BY
                s.relname
            "#
        ))
        .await?;
    Ok(records(&values)
        .map(|r| {
            (
                r.string("schema"),
                r.string("name"),
                r.string("column_name"),
            )
        })
        .collect())
}

fn with_semicolon(sql: &str) -> String {
    let sql = sql.trim_end();
    if sql.ends_with(';') {
        sql.to_owned()
    } else {
        format!("{sql};")
    }
}

/// `CREATE INDEX` statements for indexes that don't back a constraint (those come with the
/// constraint).
async fn index_definitions(session: &mut Session, oid: &str) -> Result<Vec<String>, SessionError> {
    let values = session
        .fetch_values(&format!(
            r#"
            SELECT
                pg_get_indexdef(x.indexrelid) AS definition
            FROM
                pg_index x
                JOIN pg_class i ON i.oid = x.indexrelid
            WHERE
                x.indrelid = {oid}
                AND NOT EXISTS (
                    SELECT
                        1
                    FROM
                        pg_constraint c
                    WHERE
                        c.conindid = x.indexrelid
                        AND c.contype IN ('p', 'u', 'x')
                )
            ORDER BY
                i.relname
            "#
        ))
        .await?;
    Ok(records(&values).map(|r| r.string("definition")).collect())
}

async fn table_ddl(session: &mut Session, object: &ObjectRef) -> Result<String, SessionError> {
    let structure = structure(session, object).await?;
    let oid = relation_oid(&object.schema, &object.name);
    let name = qualified(&object.schema, &object.name);

    let mut lines: Vec<String> = structure
        .columns
        .iter()
        .map(|c| {
            let mut line = format!("    {} {}", quote_ident(&c.name), c.type_name);
            match c.default_value.as_deref() {
                Some(d) if d.starts_with("GENERATED ") => line.push_str(&format!(" {d}")),
                Some(d) => line.push_str(&format!(" DEFAULT {d}")),
                None => {}
            }
            if !c.nullable {
                line.push_str(" NOT NULL");
            }
            line
        })
        .collect();
    for constraint in &structure.constraints {
        let line = match &constraint.name {
            Some(n) => format!(
                "    CONSTRAINT {} {}",
                quote_ident(n),
                constraint.definition
            ),
            None => format!("    {}", constraint.definition),
        };
        lines.push(line);
    }

    let sequences = owned_sequences(session, &oid).await?;
    let mut ddl = String::new();
    for (schema, sequence, _) in &sequences {
        let object = ObjectRef {
            schema: schema.clone(),
            name: sequence.clone(),
            kind: ObjectKind::Sequence,
            detail: None,
        };
        ddl.push_str(&sequence_ddl(session, &object).await?);
        ddl.push('\n');
    }

    let partition = scalar(session, &format!("SELECT pg_get_partkeydef({oid})")).await?;
    ddl.push_str(&format!("CREATE TABLE {name} (\n{}\n)", lines.join(",\n")));
    if let Some(partition) = partition {
        ddl.push_str(&format!("\nPARTITION BY {partition}"));
    }
    ddl.push_str(";\n");

    for (schema, sequence, column) in &sequences {
        ddl.push_str(&format!(
            "\nALTER SEQUENCE {} OWNED BY {name}.{};\n",
            qualified(schema, sequence),
            quote_ident(column)
        ));
    }
    for index in index_definitions(session, &oid).await? {
        ddl.push_str(&format!("\n{index};\n"));
    }
    for trigger in &structure.triggers {
        ddl.push_str(&format!("\n{};\n", trigger.definition));
    }
    Ok(ddl)
}
