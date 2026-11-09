/**
 * Cell selection in the grid: an anchor and a focus cell (rows and display columns), so Shift
 * extends the range from the anchor. The focus cell is the active cell.
 */
export interface CellPos {
    row: number;
    col: number;
}

export interface Selection {
    anchor: CellPos;
    focus: CellPos;
}

export interface Range {
    top: number;
    bottom: number;
    left: number;
    right: number;
}

export function at(row: number, col: number): Selection {
    return { anchor: { row, col }, focus: { row, col } };
}

export function rangeOf(selection: Selection): Range {
    const { anchor, focus } = selection;
    return {
        top: Math.min(anchor.row, focus.row),
        bottom: Math.max(anchor.row, focus.row),
        left: Math.min(anchor.col, focus.col),
        right: Math.max(anchor.col, focus.col),
    };
}

export function contains(range: Range, row: number, col: number): boolean {
    return row >= range.top && row <= range.bottom && col >= range.left && col <= range.right;
}

const clamp = (n: number, max: number) => Math.max(0, Math.min(n, max - 1));

/** Moves the focus to `to` (clamped to the grid); with `extend` the anchor stays. */
export function moveTo(selection: Selection, to: CellPos, extend: boolean, rows: number, cols: number): Selection {
    const focus = { row: clamp(to.row, rows), col: clamp(to.col, cols) };
    return { anchor: extend ? selection.anchor : focus, focus };
}

/** Moves the focus by a number of rows and columns. */
export function moveBy(
    selection: Selection,
    rowsBy: number,
    colsBy: number,
    extend: boolean,
    rows: number,
    cols: number,
): Selection {
    return moveTo(
        selection,
        { row: selection.focus.row + rowsBy, col: selection.focus.col + colsBy },
        extend,
        rows,
        cols,
    );
}

export function selectAll(rows: number, cols: number): Selection {
    return { anchor: { row: 0, col: 0 }, focus: { row: Math.max(0, rows - 1), col: Math.max(0, cols - 1) } };
}

/** Row and column numbers covered by the range, in order. */
export function spans(range: Range): { rows: number[]; cols: number[] } {
    const list = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);
    return { rows: list(range.top, range.bottom), cols: list(range.left, range.right) };
}
