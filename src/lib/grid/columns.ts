import { z } from "zod";

/**
 * A table's column layout in the grid, saved per table: display order, widths and hidden columns,
 * all by column name, so the layout survives columns being added or dropped.
 */
export interface ColumnLayout {
    order: string[];
    widths: Record<string, number>;
    hidden: string[];
}

export const EMPTY_LAYOUT: ColumnLayout = { order: [], widths: {}, hidden: [] };

export const MIN_WIDTH = 48;
export const MAX_WIDTH = 640;

const clampWidth = (w: number) => Math.round(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, w)));

const saved = z
    .object({
        order: z.array(z.string()).catch([]),
        widths: z.record(z.string(), z.number()).catch({}),
        hidden: z.array(z.string()).catch([]),
    })
    .catch(EMPTY_LAYOUT);

export function parseLayout(raw: string | null | undefined): ColumnLayout {
    if (!raw) return EMPTY_LAYOUT;
    try {
        return saved.parse(JSON.parse(raw));
    } catch {
        return EMPTY_LAYOUT;
    }
}

export function serializeLayout(layout: ColumnLayout): string {
    return JSON.stringify(layout);
}

/**
 * Indexes of `names` (the result's columns) in display order: those the layout orders first, then
 * any others in their natural order. With `includeHidden` false, hidden columns are left out.
 */
export function displayOrder(names: string[], layout: ColumnLayout, includeHidden = false): number[] {
    const used = new Set<number>();
    const result: number[] = [];
    for (const name of layout.order) {
        const index = names.findIndex((n, i) => n === name && !used.has(i));
        if (index >= 0) {
            used.add(index);
            result.push(index);
        }
    }
    names.forEach((_, i) => {
        if (!used.has(i)) result.push(i);
    });

    const hidden = new Set(layout.hidden);
    return includeHidden ? result : result.filter((i) => !hidden.has(names[i] ?? ""));
}

/** Moves column `name` to display position `to` (among all columns, hidden ones included). */
export function moveColumn(names: string[], layout: ColumnLayout, name: string, to: number): ColumnLayout {
    const order = displayOrder(names, layout, true).map((i) => names[i] ?? "");
    const from = order.indexOf(name);
    if (from < 0) return layout;
    order.splice(from, 1);
    order.splice(Math.max(0, Math.min(to, order.length)), 0, name);
    return { ...layout, order };
}

/**
 * Moves `name` one place left or right among the visible columns (the header menu's "Move left" and
 * "Move right", for keyboard users).
 */
export function shiftColumn(names: string[], layout: ColumnLayout, name: string, by: -1 | 1): ColumnLayout {
    const all = displayOrder(names, layout, true).map((i) => names[i] ?? "");
    const visible = displayOrder(names, layout).map((i) => names[i] ?? "");
    const at = visible.indexOf(name);
    const neighbor = visible[at + by];
    if (at < 0 || neighbor === undefined) return layout;
    return moveColumn(names, layout, name, all.indexOf(neighbor));
}

export function setHidden(layout: ColumnLayout, name: string, hidden: boolean): ColumnLayout {
    const rest = layout.hidden.filter((n) => n !== name);
    return { ...layout, hidden: hidden ? [...rest, name] : rest };
}

export function setWidth(layout: ColumnLayout, name: string, width: number): ColumnLayout {
    return { ...layout, widths: { ...layout.widths, [name]: clampWidth(width) } };
}

/** A starting width from the header and a sample of cell texts, in pixels for `charWidth` per character. */
export function initialWidth(header: string, samples: string[], charWidth: number): number {
    const longest = Math.max(header.length + 3, ...samples.map((s) => Math.min(s.length, 60)));
    return clampWidth(longest * charWidth + 20);
}
