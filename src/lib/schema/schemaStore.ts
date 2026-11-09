import { backend, errorMessage } from "@/lib/ipc/backend";
import { type CompletionTable, events, type SchemaColumn, type SchemaObject } from "@/lib/ipc/bindings";
import { log } from "@/lib/shell/log";
import { Store } from "@/lib/util/store";

/**
 * The frontend's copy of each connection's cached schema (Explorer, search, autocomplete). It loads
 * from the app database on first use and reloads when the backend reports `schema-changed`.
 * `version` counts reloads, for views that keep derived data.
 */
export interface SchemaState {
    objects: SchemaObject[];
    refreshedAt: string | null;
    loading: boolean;
    error: string | null;
    version: number;
}

const EMPTY: SchemaState = { objects: [], refreshedAt: null, loading: false, error: null, version: 0 };

export const schemaStore = new Store<ReadonlyMap<string, SchemaState>>(new Map());

const columnsCache = new Map<string, Promise<SchemaColumn[]>>();
const completionCache = new Map<string, Promise<CompletionTable[]>>();

function patch(connectionId: string, change: Partial<SchemaState>) {
    schemaStore.update((map) => {
        const next = new Map(map);
        next.set(connectionId, { ...(map.get(connectionId) ?? EMPTY), ...change });
        return next;
    });
}

function forget(connectionId: string) {
    for (const key of [...columnsCache.keys()]) {
        if (key.startsWith(`${connectionId}\u0000`)) columnsCache.delete(key);
    }
    completionCache.delete(connectionId);
}

/** Reads the connection's schema from the cache into the store. */
export async function loadSchema(connectionId: string): Promise<void> {
    const version = (schemaStore.get().get(connectionId)?.version ?? 0) + 1;
    try {
        const tree = await backend.schemaTree(connectionId);
        patch(connectionId, { objects: tree.objects, refreshedAt: tree.refreshed_at, version, error: null });
    } catch (e) {
        patch(connectionId, { error: errorMessage(e), version });
    }
}

/** Reloads the schema from the database (Explorer's Refresh); the result arrives as an event. */
export async function refreshSchema(connectionId: string): Promise<void> {
    patch(connectionId, { loading: true, error: null });
    try {
        await backend.refreshSchema(connectionId);
    } catch (e) {
        patch(connectionId, { loading: false, error: errorMessage(e) });
    }
}

/** Marks a schema as loading while a connect loads it for the first time. */
export function markLoading(connectionId: string) {
    patch(connectionId, { loading: true });
}

/** Starts loading a connection's schema the first time it's needed. */
export function ensureSchema(connectionId: string) {
    if (schemaStore.get().has(connectionId)) return;
    patch(connectionId, {});
    void loadSchema(connectionId);
}

/** Columns of one table or view, from the cache. */
export function tableColumns(connectionId: string, schema: string, table: string): Promise<SchemaColumn[]> {
    const key = `${connectionId}\u0000${schema}\u0000${table}`;
    let promise = columnsCache.get(key);
    if (!promise) {
        promise = backend.tableColumns(connectionId, schema, table).catch(() => []);
        columnsCache.set(key, promise);
    }
    return promise;
}

/** Every table's column names, for autocomplete. */
export function completionTables(connectionId: string): Promise<CompletionTable[]> {
    let promise = completionCache.get(connectionId);
    if (!promise) {
        promise = backend.completionColumns(connectionId).catch(() => []);
        completionCache.set(connectionId, promise);
    }
    return promise;
}

/**
 * Listens for `schema-changed`: reloads that connection's schema and logs the load as background
 * SQL. Returns the unlisten function.
 */
export function listenForSchemaChanges(connectionName: (id: string) => string): () => void {
    const unlisten = events.schemaChanged.listen(({ payload }) => {
        const id = payload.connection_id;
        forget(id);
        patch(id, { loading: false });
        void loadSchema(id);
        const ms = Math.round(payload.duration_ms ?? 0);
        log(
            payload.error
                ? { kind: "error", source: connectionName(id), text: `Loading the schema failed: ${payload.error}` }
                : {
                      kind: "background",
                      source: connectionName(id),
                      text: `Loaded the schema: ${payload.objects} objects`,
                      detail: `${ms} ms`,
                  },
        );
    });
    return () => void unlisten.then((off) => off());
}
