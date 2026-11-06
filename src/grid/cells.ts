import type { Cell, NullDisplay } from "@/lib/bindings";
import { formatBytes } from "@/lib/numbers";

export type CellKind = "null" | "text" | "binary";

export interface CellOptions {
    nullDisplay: NullDisplay;
    jsonTruncation: number;
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
        return { text: cell, kind: "text" };
    }
    if ("cut" in cell) return { text: `${cell.cut}…`, kind: "text" };

    const size = formatBytes(cell.binary);
    const image = cell.image ? `${cell.image.toUpperCase()} image` : "binary";
    return { text: `<${image} ${size}>`, kind: "binary" };
}
