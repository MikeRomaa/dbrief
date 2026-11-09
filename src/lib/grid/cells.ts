import { displayDate } from "@/lib/grid/dates";
import type { Cell, DateFormat, NullDisplay } from "@/lib/ipc/bindings";
import { formatBytes } from "@/lib/util/numbers";

export type CellKind = "null" | "text" | "binary";

export interface CellOptions {
    nullDisplay: NullDisplay;
    jsonTruncation: number;
    dateFormat?: DateFormat;
}

/** Whether a result type name holds dates or date-times (for the date format setting). */
export function dateKind(typeName: string): "date" | "datetime" | null {
    if (/^date$/i.test(typeName)) return "date";
    if (/^(timestamp|timestamptz|datetime)\b/i.test(typeName)) return "datetime";
    return null;
}

const NULL_TEXT: Record<NullDisplay, string> = { null: "NULL", symbol: "∅", blank: "" };

const isJson = (typeName: string) => /^jsonb?$/i.test(typeName);

/** What a grid cell shows, and how it is styled. Long values end in "…"; the inspector has them whole. */
export function cellText(cell: Cell | null, typeName: string, options: CellOptions): { text: string; kind: CellKind } {
    if (cell === null) return { text: NULL_TEXT[options.nullDisplay], kind: "null" };
    if (typeof cell === "string") {
        if (isJson(typeName) && cell.length > options.jsonTruncation) {
            return { text: `${cell.slice(0, options.jsonTruncation)}…`, kind: "text" };
        }
        const date = options.dateFormat === "locale" ? dateKind(typeName) : null;
        if (date) return { text: displayDate(cell, date, "locale"), kind: "text" };
        return { text: cell, kind: "text" };
    }
    if ("cut" in cell) return { text: `${cell.cut}…`, kind: "text" };

    const size = formatBytes(cell.binary);
    const image = cell.image ? `${cell.image.toUpperCase()} image` : "binary";
    return { text: `<${image} ${size}>`, kind: "binary" };
}
