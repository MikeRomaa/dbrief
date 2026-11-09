import { Store } from "@/lib/util/store";

/** The kinds of Log entries, each with its own filter. */
export type LogKind = "notice" | "statement" | "transaction" | "error" | "background";

export const LOG_KINDS: { kind: LogKind; label: string }[] = [
    { kind: "statement", label: "Statements" },
    { kind: "notice", label: "Notices" },
    { kind: "transaction", label: "Transactions" },
    { kind: "error", label: "Errors" },
    { kind: "background", label: "Background" },
];

/** One Log line. `source` names the tab or view it came from; `detail` holds extra lines (error detail, hint). */
export interface LogEntry {
    id: number;
    at: Date;
    kind: LogKind;
    source: string;
    text: string;
    detail?: string;
}

/** Entries kept; older ones are dropped. */
const LIMIT = 2000;

export const logStore = new Store<LogEntry[]>([]);
let nextId = 1;

export function log(entry: Omit<LogEntry, "id" | "at">) {
    logStore.update((entries) => {
        const next = [...entries, { ...entry, id: nextId++, at: new Date() }];
        return next.length > LIMIT ? next.slice(next.length - LIMIT) : next;
    });
}

export function clearLog() {
    logStore.set([]);
}
