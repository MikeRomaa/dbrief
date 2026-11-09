import type { Column, RunError_Serialize, RunOutput_Serialize } from "@/lib/ipc/bindings";
import { Store } from "@/lib/util/store";

export type Row = (string | null)[];

/**
 * One statement's result in a script tab: running, finished (rows or a command's row count), or
 * failed. `index` numbers results in the tab ("Result 3"); `offset` is where the statement starts
 * in the editor, for pointing at an error position.
 */
export type ResultEntry =
    | { id: string; index: number; sql: string; status: "running"; started: number }
    | {
          id: string;
          index: number;
          sql: string;
          status: "done";
          output: RunOutput_Serialize;
          columns: Column[] | null;
          rows: Row[];
          more: boolean;
          rowsAffected: number | null;
          loadingMore: boolean;
      }
    | { id: string; index: number; sql: string; status: "failed"; error: RunError_Serialize; offset: number };

/** The results of one tab, by id. */
export type ResultMap = ReadonlyMap<string, ResultEntry>;

export function createResultStore() {
    return new Store<ResultMap>(new Map());
}

export function putResult(store: Store<ResultMap>, entry: ResultEntry) {
    store.update((map) => new Map(map).set(entry.id, entry));
}

export function dropResult(store: Store<ResultMap>, id: string) {
    store.update((map) => {
        const next = new Map(map);
        next.delete(id);
        return next;
    });
}

/** The actions a result block offers; provided by the tab that owns the session. */
export interface ResultActions {
    loadMore: (id: string) => void;
    cancel: () => void;
    close: (id: string) => void;
    popOut?: (id: string) => void;
    exportResult: (id: string, format: ExportFormat) => void;
}

export type ExportFormat = "csv" | "json" | "sql";

/** The result shown in the bottom panel: popped out, or every result when results aren't inline. */
export interface BottomResult {
    tab: string;
    store: Store<ResultMap>;
    id: string;
    actions: ResultActions;
}

export const bottomResult = new Store<BottomResult | null>(null);

/** Rows as tab-separated text with a header line, for pasting into a spreadsheet. */
export function toTsv(columns: Column[], rows: Row[]): string {
    const clean = (v: string | null) => (v ?? "").replace(/[\t\r\n]+/g, " ");
    return [columns.map((c) => clean(c.name)).join("\t"), ...rows.map((r) => r.map(clean).join("\t"))].join("\n");
}

/** Database type names that hold numbers, so their cells line up on the right. */
const NUMERIC =
    /^(int|integer|smallint|bigint|int2|int4|int8|real|float|float4|float8|double|numeric|decimal|money|oid)/i;

export function isNumeric(typeName: string): boolean {
    return NUMERIC.test(typeName);
}
