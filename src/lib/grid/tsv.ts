/**
 * Reads tab-separated text the way spreadsheets write it: fields that start with `"` are quoted and
 * may hold tabs, line breaks and `""` for a quote. Rows end at `\n` or `\r\n`; one trailing line
 * break is ignored. Unquoted fields are taken as they are.
 */
export function parseTsv(text: string): string[][] {
    const rows: string[][] = [];
    let row: string[] = [];
    let i = 0;
    const n = text.length;
    if (n === 0) return [];

    while (i <= n) {
        let field = "";
        if (text[i] === '"') {
            i++;
            while (i < n) {
                if (text[i] === '"') {
                    if (text[i + 1] === '"') {
                        field += '"';
                        i += 2;
                        continue;
                    }
                    i++;
                    break;
                }
                field += text[i];
                i++;
            }
            // Anything after the closing quote up to the separator belongs to the field.
            while (i < n && text[i] !== "\t" && text[i] !== "\n" && text[i] !== "\r") {
                field += text[i];
                i++;
            }
        } else {
            while (i < n && text[i] !== "\t" && text[i] !== "\n" && text[i] !== "\r") {
                field += text[i];
                i++;
            }
        }
        row.push(field);

        if (i >= n) {
            rows.push(row);
            break;
        }
        if (text[i] === "\t") {
            i++;
            continue;
        }
        // A line break ends the row.
        if (text[i] === "\r" && text[i + 1] === "\n") i++;
        i++;
        rows.push(row);
        row = [];
        if (i >= n) break;
    }
    return rows;
}

/** One pasted value: a grid row (past the last row means a new row), a display column, and text. */
export interface PastedCell {
    row: number;
    col: number;
    text: string;
}

/**
 * Where a pasted block lands. A single value with a larger selection fills the selection; otherwise
 * the block starts at the selection's top-left cell. Columns past the last one are dropped; rows
 * past `rows` are returned too, for the caller to add as new rows.
 */
export function planPaste(
    block: string[][],
    range: { top: number; bottom: number; left: number; right: number },
    cols: number,
): PastedCell[] {
    const cells: PastedCell[] = [];
    const single = block.length === 1 && block[0]?.length === 1;
    if (single && (range.bottom > range.top || range.right > range.left)) {
        const text = block[0]?.[0] ?? "";
        for (let row = range.top; row <= range.bottom; row++) {
            for (let col = range.left; col <= range.right && col < cols; col++) cells.push({ row, col, text });
        }
        return cells;
    }
    block.forEach((values, r) => {
        values.forEach((text, c) => {
            const col = range.left + c;
            if (col < cols) cells.push({ row: range.top + r, col, text });
        });
    });
    return cells;
}
