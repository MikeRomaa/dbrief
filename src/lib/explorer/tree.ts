import type { Engine, ObjectKind, SchemaColumn, SchemaObject } from "@/lib/ipc/bindings";

/**
 * The Explorer's rows: the schema cache as a tree, flattened to the rows currently shown.
 * PostgreSQL: schemas → kind groups → objects → columns. SQLite: the main database's kind groups at
 * the top, attached databases as extra top-level nodes.
 */
export type ExplorerRow =
    | { type: "schema"; id: string; level: number; schema: string; expanded: boolean }
    | { type: "group"; id: string; level: number; schema: string; kind: ObjectKind; count: number; expanded: boolean }
    | { type: "object"; id: string; level: number; object: SchemaObject; expandable: boolean; expanded: boolean }
    | { type: "column"; id: string; level: number; column: SchemaColumn }
    | { type: "note"; id: string; level: number; text: string };

export const GROUP_LABELS: Record<ObjectKind, string> = {
    schema: "Schemas",
    table: "Tables",
    view: "Views",
    "materialized-view": "Materialized views",
    function: "Functions",
    sequence: "Sequences",
    index: "Indexes",
    trigger: "Triggers",
};

const GROUP_ORDER: Record<Engine, ObjectKind[]> = {
    postgres: ["table", "view", "materialized-view", "function", "sequence"],
    sqlite: ["table", "view", "index", "trigger"],
};

export const schemaId = (schema: string) => `s:${schema}`;
export const groupId = (schema: string, kind: ObjectKind) => `g:${schema}:${kind}`;
export const objectId = (o: Pick<SchemaObject, "schema" | "kind" | "name" | "detail">) =>
    `o:${o.schema}:${o.kind}:${o.name}:${o.detail ?? ""}`;

/** The SQLite database whose groups sit at the top level. */
const SQLITE_MAIN = "main";

/** Rows expanded when a connection's tree is first shown: its default schema and tables. */
export function defaultExpanded(engine: Engine): Set<string> {
    return engine === "sqlite"
        ? new Set([groupId(SQLITE_MAIN, "table")])
        : new Set([schemaId("public"), groupId("public", "table")]);
}

/**
 * Builds the visible rows. `filter` keeps objects whose name contains it (ignoring case) and shows
 * their schema and group open. `columns` holds the loaded columns of expanded tables, by object id.
 */
export function buildRows(
    objects: SchemaObject[],
    engine: Engine,
    expanded: ReadonlySet<string>,
    columns: ReadonlyMap<string, SchemaColumn[]>,
    filter: string,
): ExplorerRow[] {
    const needle = filter.trim().toLowerCase();
    const rows: ExplorerRow[] = [];

    const schemas = new Map<string, SchemaObject[]>();
    for (const o of objects) {
        if (o.kind === "schema") {
            if (!schemas.has(o.schema)) schemas.set(o.schema, []);
            continue;
        }
        if (needle && !o.name.toLowerCase().includes(needle)) continue;
        const list = schemas.get(o.schema) ?? [];
        list.push(o);
        schemas.set(o.schema, list);
    }

    const pushGroups = (schema: string, list: SchemaObject[], level: number) => {
        for (const kind of GROUP_ORDER[engine]) {
            const members = list.filter((o) => o.kind === kind);
            if (members.length === 0) continue;
            const id = groupId(schema, kind);
            const open = !!needle || expanded.has(id);
            rows.push({ type: "group", id, level, schema, kind, count: members.length, expanded: open });
            if (!open) continue;
            for (const object of members) {
                const oid = objectId(object);
                const expandable =
                    object.kind === "table" || object.kind === "view" || object.kind === "materialized-view";
                const objectOpen = expandable && expanded.has(oid);
                rows.push({ type: "object", id: oid, level: level + 1, object, expandable, expanded: objectOpen });
                if (!objectOpen) continue;
                const cols = columns.get(oid);
                if (!cols) {
                    rows.push({ type: "note", id: `${oid}:loading`, level: level + 2, text: "Loading…" });
                } else if (cols.length === 0) {
                    rows.push({ type: "note", id: `${oid}:none`, level: level + 2, text: "No columns" });
                } else {
                    for (const column of cols) {
                        rows.push({ type: "column", id: `${oid}:c:${column.name}`, level: level + 2, column });
                    }
                }
            }
        }
    };

    const names = [...schemas.keys()].sort((a, b) => a.localeCompare(b));
    if (engine === "sqlite") {
        // main first and flat; attached databases follow as nodes.
        pushGroups(SQLITE_MAIN, schemas.get(SQLITE_MAIN) ?? [], 1);
        for (const name of names) {
            if (name === SQLITE_MAIN) continue;
            const list = schemas.get(name) ?? [];
            if (needle && list.length === 0) continue;
            const open = (!!needle && list.length > 0) || expanded.has(schemaId(name));
            rows.push({ type: "schema", id: schemaId(name), level: 1, schema: name, expanded: open });
            if (open) pushGroups(name, list, 2);
        }
    } else {
        for (const name of names) {
            const list = schemas.get(name) ?? [];
            if (needle && list.length === 0) continue;
            const open = (!!needle && list.length > 0) || expanded.has(schemaId(name));
            rows.push({ type: "schema", id: schemaId(name), level: 1, schema: name, expanded: open });
            if (!open) continue;
            if (list.length === 0) {
                rows.push({ type: "note", id: `${schemaId(name)}:empty`, level: 2, text: "Empty schema" });
            } else {
                pushGroups(name, list, 2);
            }
        }
    }
    return rows;
}

/** The row's parent, for Left (collapse or go to parent) in the tree. */
export function parentIndex(rows: ExplorerRow[], index: number): number {
    const level = rows[index]?.level ?? 1;
    for (let i = index - 1; i >= 0; i--) {
        if ((rows[i]?.level ?? 0) < level) return i;
    }
    return -1;
}
