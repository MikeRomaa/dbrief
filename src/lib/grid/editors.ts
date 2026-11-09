import { parseDate, parseDateTime } from "@/lib/grid/dates";
import { parsePgArray } from "@/lib/grid/pgArray";
import type { Engine } from "@/lib/ipc/bindings";

/**
 * The editor a column gets, from its declared type (a domain's base type on PostgreSQL). Arrays and
 * binary values edit in the inspector; the other kinds edit in the cell.
 */
export type EditorKind = "text" | "integer" | "number" | "boolean" | "date" | "datetime" | "json" | "array" | "binary";

/** What an in-cell editor needs: the column's editor kind and type, and the starting text. */
export interface EditorSpec {
    kind: EditorKind;
    typeName: string;
    engine: Engine;
    nullable: boolean;
    /** A datetime that keeps its UTC offset (`timestamptz`). */
    timeZone: boolean;
    initial: string;
    /** `initial` is typed text that replaces the value, so saving it is always a change. */
    replaced?: boolean;
    /** Fetches the whole value when `initial` is cut short; the editor waits for it before editing. */
    load?: () => Promise<string>;
    /** Names the cell for screen readers, e.g. "price, row 4". */
    label: string;
}

const PG_INTEGERS: Record<string, bigint> = {
    smallint: 32767n,
    integer: 2147483647n,
    bigint: 9223372036854775807n,
};

export function editorKind(typeName: string, engine: Engine): EditorKind {
    const t = typeName.trim().toLowerCase();
    if (engine === "postgres") {
        if (t.endsWith("[]")) return "array";
        const base = t.replace(/\(.*\)/, "").trim();
        if (base in PG_INTEGERS) return "integer";
        if (["real", "double precision", "numeric", "decimal"].includes(base)) return "number";
        if (base === "boolean") return "boolean";
        if (base === "date") return "date";
        if (base.startsWith("timestamp")) return "datetime";
        if (base === "json" || base === "jsonb") return "json";
        if (base === "bytea") return "binary";
        return "text";
    }

    // SQLite: by the words of the declared type, as its affinity rules read them.
    if (t.includes("bool")) return "boolean";
    if (t.includes("int")) return "number";
    if (t.includes("datetime") || t.includes("timestamp")) return "datetime";
    if (t.includes("date")) return "date";
    if (t.includes("json")) return "json";
    if (t.includes("blob")) return "binary";
    if (/real|floa|doub|numeric|decimal/.test(t)) return "number";
    return "text";
}

/** Whether a PostgreSQL datetime type keeps a UTC offset. */
export function hasTimeZone(typeName: string): boolean {
    return /with time zone|timestamptz/i.test(typeName);
}

const NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

/**
 * Checks text typed for a column before it is staged. Returns the problem, or `null` when the
 * database should accept it. Kinds the database checks better (enums, ranges, UUIDs) pass.
 */
export function validate(kind: EditorKind, text: string, typeName: string, engine: Engine): string | null {
    const t = text.trim();
    switch (kind) {
        case "integer": {
            if (!/^[+-]?\d+$/.test(t)) return "Enter a whole number.";
            const base = typeName
                .trim()
                .toLowerCase()
                .replace(/\(.*\)/, "");
            const max = PG_INTEGERS[base] ?? PG_INTEGERS.bigint;
            const n = BigInt(t);
            if (max !== undefined && (n > max || n < -max - 1n)) return `Out of range for ${base}.`;
            return null;
        }
        case "number":
            if (NUMBER.test(t)) return null;
            if (engine === "postgres" && /^([+-]?infinity|nan)$/i.test(t)) return null;
            return "Enter a number.";
        case "boolean":
            return /^(true|false|t|f|1|0|yes|no|on|off)$/i.test(t) ? null : "Enter true or false.";
        case "date":
            if (engine === "postgres" && /^-?infinity$/i.test(t)) return null;
            return parseDate(t) || engine === "sqlite" ? null : "Enter a date as YYYY-MM-DD.";
        case "datetime":
            if (engine === "postgres" && /^-?infinity$/i.test(t)) return null;
            return parseDateTime(t) || engine === "sqlite" ? null : "Enter a date and time as YYYY-MM-DD HH:MM:SS.";
        case "json":
            try {
                JSON.parse(text);
                return null;
            } catch (e) {
                return `Invalid JSON: ${e instanceof Error ? e.message : String(e)}`;
            }
        case "array":
            return parsePgArray(text) ? null : "Enter an array literal such as {a,b}.";
        default:
            return null;
    }
}

/**
 * Whether text holds a JSON object or array, so the inspector can offer the JSON editor for a text
 * column (SQLite has no JSON type). Scalars like `42` or `true` don't count: too much plain text
 * would look like JSON.
 */
export function looksLikeJson(text: string): boolean {
    const t = text.trim();
    if (!((t.startsWith("{") && t.endsWith("}")) || (t.startsWith("[") && t.endsWith("]")))) return false;
    try {
        const parsed: unknown = JSON.parse(t);
        return typeof parsed === "object" && parsed !== null;
    } catch {
        return false;
    }
}

/** Boolean text as each engine stores it. */
export function booleanText(value: boolean, engine: Engine): string {
    return engine === "postgres" ? (value ? "true" : "false") : value ? "1" : "0";
}

/** Whether text read from the database means true (`t`, `true`, `1`). */
export function isTrue(text: string): boolean {
    return /^(t|true|1|yes|on)$/i.test(text.trim());
}
