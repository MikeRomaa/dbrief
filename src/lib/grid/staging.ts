import type { Change, ColumnValue, ImageKind, NewValue } from "@/lib/ipc/bindings";

/**
 * Staged grid changes for one loaded page: updates and deletes of page rows, and inserted rows.
 * States are immutable; every edit returns a new state, so undo keeps the earlier ones.
 *
 * Rules: editing a cell back to its original value drops that edit; deleting an inserted row removes
 * it; deleting an updated row keeps its edits, so reverting the delete brings them back; deleted
 * rows can't be edited. Original values stay in the backend: `original` values point at a page row,
 * and a staged file is a token for bytes the session holds.
 *
 * The grid lists page rows first, then inserted rows, so a grid row index maps to a `RowRef` with
 * `rowAt`.
 */
export type StagedValue =
    | { kind: "null" }
    | { kind: "default" }
    | { kind: "text"; text: string }
    | { kind: "original"; row: number }
    | { kind: "file"; token: string; size: number; image: ImageKind | null };

export type RowRef = { kind: "page"; row: number } | { kind: "insert"; id: number };

export interface InsertedRow {
    id: number;
    values: ReadonlyMap<string, StagedValue>;
}

export interface Staging {
    updates: ReadonlyMap<number, ReadonlyMap<string, StagedValue>>;
    deletes: ReadonlySet<number>;
    inserts: readonly InsertedRow[];
    nextId: number;
}

export const EMPTY_STAGING: Staging = { updates: new Map(), deletes: new Set(), inserts: [], nextId: 1 };

export type RowState = "updated" | "inserted" | "deleted" | null;

export function rowAt(staging: Staging, pageRows: number, index: number): RowRef | null {
    if (index < pageRows) return index >= 0 ? { kind: "page", row: index } : null;
    const inserted = staging.inserts[index - pageRows];
    return inserted ? { kind: "insert", id: inserted.id } : null;
}

/** The grid row index of a row, or -1 when it is gone. */
export function indexOf(staging: Staging, pageRows: number, ref: RowRef): number {
    if (ref.kind === "page") return ref.row;
    const i = staging.inserts.findIndex((r) => r.id === ref.id);
    return i < 0 ? -1 : pageRows + i;
}

export function rowState(staging: Staging, ref: RowRef): RowState {
    if (ref.kind === "insert") return staging.inserts.some((r) => r.id === ref.id) ? "inserted" : null;
    if (staging.deletes.has(ref.row)) return "deleted";
    return staging.updates.has(ref.row) ? "updated" : null;
}

/** The staged value of a cell; `undefined` when it isn't edited (or, for an inserted row, is DEFAULT). */
export function cellValue(staging: Staging, ref: RowRef, column: string): StagedValue | undefined {
    if (ref.kind === "page") return staging.updates.get(ref.row)?.get(column);
    return staging.inserts.find((r) => r.id === ref.id)?.values.get(column);
}

function withValue(
    values: ReadonlyMap<string, StagedValue> | undefined,
    column: string,
    value: StagedValue | null,
): Map<string, StagedValue> {
    const next = new Map(values);
    if (value) next.set(column, value);
    else next.delete(column);
    return next;
}

/**
 * Stages `value` for a cell. `isOriginal` says the value equals the page's original value, which
 * drops the edit instead. A DEFAULT in an inserted row is the same as no value.
 */
export function setCell(
    staging: Staging,
    ref: RowRef,
    column: string,
    value: StagedValue,
    isOriginal = false,
): Staging {
    if (ref.kind === "insert") {
        const inserts = staging.inserts.map((r) =>
            r.id === ref.id
                ? { ...r, values: withValue(r.values, column, value.kind === "default" ? null : value) }
                : r,
        );
        return { ...staging, inserts };
    }
    if (staging.deletes.has(ref.row)) return staging;
    const values = withValue(staging.updates.get(ref.row), column, isOriginal ? null : value);
    const updates = new Map(staging.updates);
    if (values.size) updates.set(ref.row, values);
    else updates.delete(ref.row);
    return { ...staging, updates };
}

export function revertCell(staging: Staging, ref: RowRef, column: string): Staging {
    if (ref.kind === "insert") return setCell(staging, ref, column, { kind: "default" });
    const values = withValue(staging.updates.get(ref.row), column, null);
    const updates = new Map(staging.updates);
    if (values.size) updates.set(ref.row, values);
    else updates.delete(ref.row);
    return { ...staging, updates };
}

/** Reverts every change of a row: its edits and delete, or removes it if it was inserted. */
export function revertRow(staging: Staging, ref: RowRef): Staging {
    if (ref.kind === "insert") return { ...staging, inserts: staging.inserts.filter((r) => r.id !== ref.id) };
    const updates = new Map(staging.updates);
    updates.delete(ref.row);
    const deletes = new Set(staging.deletes);
    deletes.delete(ref.row);
    return { ...staging, updates, deletes };
}

/** Marks rows deleted; inserted rows are removed. Already deleted rows stay deleted. */
export function deleteRows(staging: Staging, refs: RowRef[]): Staging {
    const gone = new Set(refs.filter((r) => r.kind === "insert").map((r) => r.id));
    const deletes = new Set(staging.deletes);
    for (const ref of refs) if (ref.kind === "page") deletes.add(ref.row);
    return { ...staging, deletes, inserts: staging.inserts.filter((r) => !gone.has(r.id)) };
}

/** Takes back the delete of a row, keeping its edits. */
export function undelete(staging: Staging, row: number): Staging {
    const deletes = new Set(staging.deletes);
    deletes.delete(row);
    return { ...staging, deletes };
}

/** Adds an inserted row with `values` (others are DEFAULT); returns the state and the new row. */
export function addRow(staging: Staging, values: ReadonlyMap<string, StagedValue> = new Map()): [Staging, RowRef] {
    const id = staging.nextId;
    const kept = new Map([...values].filter(([, v]) => v.kind !== "default"));
    return [
        { ...staging, inserts: [...staging.inserts, { id, values: kept }], nextId: id + 1 },
        { kind: "insert", id },
    ];
}

export interface StagedCounts {
    updated: number;
    inserted: number;
    deleted: number;
    total: number;
}

export function counts(staging: Staging): StagedCounts {
    const updated = [...staging.updates.keys()].filter((row) => !staging.deletes.has(row)).length;
    const inserted = staging.inserts.length;
    const deleted = staging.deletes.size;
    return { updated, inserted, deleted, total: updated + inserted + deleted };
}

export function isEmpty(staging: Staging): boolean {
    return counts(staging).total === 0;
}

/** "3 edits, 1 insert, 1 delete", as the staged changes bar says it. */
export function summary(c: StagedCounts): string {
    const parts: string[] = [];
    const add = (n: number, word: string) => n && parts.push(`${n} ${word}${n === 1 ? "" : "s"}`);
    add(c.updated, "edit");
    add(c.inserted, "insert");
    add(c.deleted, "delete");
    return parts.join(", ");
}

function toNewValue(value: StagedValue): NewValue {
    return value.kind === "file" ? { kind: "file", token: value.token } : value;
}

function columnValues(values: ReadonlyMap<string, StagedValue>): ColumnValue[] {
    return [...values].map(([column, value]) => ({ column, value: toNewValue(value) }));
}

/**
 * The changes to send to the backend, and the row each one is about (the backend reports failures
 * by change index). Deleted rows send only their delete.
 */
export function toChanges(staging: Staging): { changes: Change[]; rows: RowRef[] } {
    const changes: Change[] = [];
    const rows: RowRef[] = [];
    for (const row of [...staging.deletes].sort((a, b) => a - b)) {
        changes.push({ kind: "delete", row });
        rows.push({ kind: "page", row });
    }
    for (const [row, values] of [...staging.updates].sort(([a], [b]) => a - b)) {
        if (staging.deletes.has(row)) continue;
        changes.push({ kind: "update", row, values: columnValues(values) });
        rows.push({ kind: "page", row });
    }
    for (const inserted of staging.inserts) {
        changes.push({ kind: "insert", values: columnValues(inserted.values) });
        rows.push({ kind: "insert", id: inserted.id });
    }
    return { changes, rows };
}

/** Whether any staged value is an uploaded file (so the session holds bytes for it). */
export function hasFiles(staging: Staging): boolean {
    const files = (values: ReadonlyMap<string, StagedValue>) => [...values.values()].some((v) => v.kind === "file");
    return [...staging.updates.values()].some(files) || staging.inserts.some((r) => files(r.values));
}

/** Staging states with undo and redo. */
export interface StagingHistory {
    past: readonly Staging[];
    current: Staging;
    future: readonly Staging[];
}

export const EMPTY_HISTORY: StagingHistory = { past: [], current: EMPTY_STAGING, future: [] };

const HISTORY_LIMIT = 200;

export function push(history: StagingHistory, next: Staging): StagingHistory {
    if (next === history.current) return history;
    return { past: [...history.past, history.current].slice(-HISTORY_LIMIT), current: next, future: [] };
}

export function undo(history: StagingHistory): StagingHistory {
    const previous = history.past[history.past.length - 1];
    if (!previous) return history;
    return { past: history.past.slice(0, -1), current: previous, future: [history.current, ...history.future] };
}

export function redo(history: StagingHistory): StagingHistory {
    const [next, ...future] = history.future;
    if (!next) return history;
    return { past: [...history.past, history.current], current: next, future };
}
