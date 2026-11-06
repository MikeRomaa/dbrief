/**
 * Header-click sorting writes the ORDER BY field. Clicking cycles a column ascending → descending →
 * unsorted; Shift-click adds it after the columns already sorted. Only ORDER BY text made of quoted
 * column names with ASC/DESC is understood; any other text is replaced by the click.
 */
export type Direction = "asc" | "desc";

interface Term {
    column: string;
    direction: Direction;
}

const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;

const TERM = /^\s*"((?:[^"]|"")+)"\s*(asc|desc)?\s*$/i;

function parse(order: string): Term[] | null {
    if (!order.trim()) return [];
    const terms: Term[] = [];
    // Split on commas outside double quotes.
    const parts = order.match(/(?:[^,"]|"(?:[^"]|"")*")+/g) ?? [];
    for (const part of parts) {
        const m = TERM.exec(part);
        if (!m) return null;
        terms.push({
            column: (m[1] ?? "").replaceAll('""', '"'),
            direction: m[2]?.toLowerCase() === "desc" ? "desc" : "asc",
        });
    }
    return terms;
}

function format(terms: Term[]): string {
    return terms.map((t) => `${quote(t.column)} ${t.direction.toUpperCase()}`).join(", ");
}

/** How `column` is sorted by the ORDER BY text, and its position when several columns are. */
export function sortOf(order: string, column: string): { direction: Direction; position: number } | null {
    const terms = parse(order) ?? [];
    const index = terms.findIndex((t) => t.column === column);
    const term = terms[index];
    return term ? { direction: term.direction, position: index + 1 } : null;
}

/** The ORDER BY text after clicking `column`'s header (`add` for Shift-click). */
export function cycleSort(order: string, column: string, add: boolean): string {
    const terms = parse(order) ?? [];
    const current = terms.find((t) => t.column === column);
    const next: Direction | null = !current ? "asc" : current.direction === "asc" ? "desc" : null;

    if (!add) return next ? format([{ column, direction: next }]) : "";
    const rest = terms.filter((t) => t.column !== column);
    if (!next) return format(rest);
    if (current) return format(terms.map((t) => (t.column === column ? { column, direction: next } : t)));
    return format([...rest, { column, direction: next }]);
}

/** ORDER BY text sorting one column a given way (header menu). */
export function sortBy(column: string, direction: Direction): string {
    return format([{ column, direction }]);
}
