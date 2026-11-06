import type { ObjectKind } from "@/lib/bindings";
import { Store } from "@/lib/store";

/**
 * A table tab names a table or view of a connection. Its tab key starts with "/table/", which no
 * script path can (they are relative), so script renames and deletes never touch it.
 */
export interface TableRef {
    connectionId: string;
    schema: string;
    name: string;
    kind: ObjectKind;
}

const PREFIX = "/table/";
const KINDS: readonly ObjectKind[] = ["table", "view", "materialized-view"];

export function tableKey(table: TableRef): string {
    return `${PREFIX}${table.connectionId}/${table.kind}/${encodeURIComponent(table.schema)}/${encodeURIComponent(table.name)}`;
}

export function isTableKey(key: string): boolean {
    return key.startsWith(PREFIX);
}

/** The table a tab key names; `null` for script tabs or a malformed key. */
export function parseTableKey(key: string): TableRef | null {
    if (!isTableKey(key)) return null;
    const parts = key.slice(PREFIX.length).split("/");
    if (parts.length !== 4) return null;

    const [connectionId, kind, schema, name] = parts as [string, string, string, string];
    const found = KINDS.find((k) => k === kind);
    if (!connectionId || !found) return null;
    try {
        return { connectionId, kind: found, schema: decodeURIComponent(schema), name: decodeURIComponent(name) };
    } catch {
        return null;
    }
}

/** `schema.name`, leaving out SQLite's "main" and PostgreSQL's "public". */
export function displayName(schema: string, name: string): string {
    return schema === "main" || schema === "public" ? name : `${schema}.${name}`;
}

/** Asks the table tab `key` to scroll to and select `column` (search results for a column). */
export const revealColumn = new Store<{ key: string; column: string } | null>(null);

/** Asks the table tab `key` to switch to a sub-view (the Explorer's "Open structure"). */
export const requestView = new Store<{ key: string; view: "data" | "columns" } | null>(null);
