import { ArrowDown, ArrowUp, KeyRound } from "lucide-react";
import {
    type CSSProperties,
    type DragEvent,
    type KeyboardEvent,
    type MouseEvent,
    useEffect,
    useLayoutEffect,
    useMemo,
    useRef,
    useState,
} from "react";

import { CellEditor, type EditorMove } from "@/components/grid/CellEditor";
import { ContextMenu, type MenuEntry } from "@/components/ui/Menu";
import { type CellOptions, cellText } from "@/lib/grid/cells";
import {
    type ColumnLayout,
    displayOrder,
    initialWidth,
    moveColumn,
    setHidden,
    setWidth,
    shiftColumn,
} from "@/lib/grid/columns";
import type { CellDisplay, GridAction, GridEditing } from "@/lib/grid/editing";
import type { EditorSpec } from "@/lib/grid/editors";
import {
    at,
    type CellPos,
    contains,
    moveBy,
    moveTo,
    rangeOf,
    type Selection,
    selectAll,
    spans,
} from "@/lib/grid/selection";
import { cycleSort, sortBy, sortOf } from "@/lib/grid/sort";
import type { Cell, Column, CopyFormat } from "@/lib/ipc/bindings";
import { isNumeric } from "@/lib/scripts/results";

import styles from "@/components/grid/DataGrid.module.css";

/**
 * A data grid for one page of rows. Rows and columns are virtualized, so wide tables and large pages
 * stay fast. Selection is a range of cells in display order; the focus cell is the active cell,
 * announced through `aria-activedescendant`. Column order, widths and hidden columns come from
 * `layout`; clicking a header writes `order` (ORDER BY text) unless `onOrderChange` is absent.
 *
 * `matches` holds find results as `row:column` (result column indexes); `onCopy` receives rows and
 * result column indexes. With `editing` the grid shows staged values and marks, opens cell editors,
 * and reports edits as actions (see `editing.ts`); `cells` then holds page rows and inserted rows.
 *
 * `transposed` draws rows as columns and columns as rows, one record per column. Only the drawing and
 * keyboard movement change: selection, find matches, copies and edits stay in row/column terms.
 */
interface DataGridProps {
    id: string;
    label: string;
    columns: Column[];
    cells: (Cell | null)[][];
    rowOffset: number;
    layout: ColumnLayout;
    onLayoutChange: (layout: ColumnLayout) => void;
    order: string;
    onOrderChange?: (order: string) => void;
    keyColumns: ReadonlySet<string>;
    options: CellOptions;
    selection: Selection;
    onSelectionChange: (selection: Selection) => void;
    matches: ReadonlySet<string>;
    currentMatch: string | null;
    onCopy: (format: CopyFormat, rows: number[], columns: number[]) => void;
    editing?: GridEditing;
    /** Caps the grid's height to this many rows (inline script results). */
    maxRows?: number;
    transposed?: boolean;
}

const HEADER_HEIGHT = 28;
const ROW_HEIGHT = 24;
const OVERSCAN_ROWS = 6;
const OVERSCAN_PX = 200;
const CHAR_WIDTH = 7.2;
/** Record (column) widths in transposed mode. */
const MIN_RECORD_WIDTH = 120;
const MAX_RECORD_WIDTH = 360;

const clampTo = (n: number, min: number, max: number) => Math.round(Math.min(max, Math.max(min, n)));
const flip = (p: CellPos): CellPos => ({ row: p.col, col: p.row });

interface Viewport {
    top: number;
    left: number;
    width: number;
    height: number;
}

type Menu = { x: number; y: number; column: number; header: boolean };

let measureCanvas: HTMLCanvasElement | null = null;

/** Width of `text` in the grid's font, for fitting a column to its content. */
function textWidth(text: string, font: string): number {
    measureCanvas ??= document.createElement("canvas");
    const context = measureCanvas.getContext("2d");
    if (!context) return text.length * CHAR_WIDTH;
    context.font = font;
    return context.measureText(text).width;
}

export function DataGrid({
    id,
    label,
    columns,
    cells,
    rowOffset,
    layout,
    onLayoutChange,
    order,
    onOrderChange,
    keyColumns,
    options,
    selection,
    onSelectionChange,
    matches,
    currentMatch,
    onCopy,
    editing,
    maxRows,
    transposed = false,
}: DataGridProps) {
    const scrollRef = useRef<HTMLDivElement>(null);
    const [viewport, setViewport] = useState<Viewport>({ top: 0, left: 0, width: 800, height: 400 });
    const [resizing, setResizing] = useState<{ name: string; width: number } | null>(null);
    const [menu, setMenu] = useState<Menu | null>(null);
    const [dropTarget, setDropTarget] = useState<{ name: string; after: boolean } | null>(null);
    const [editor, setEditor] = useState<{ row: number; col: number; spec: EditorSpec } | null>(null);
    const [recordWidth, setRecordWidth] = useState<number | null>(null);
    const [recordResize, setRecordResize] = useState<number | null>(null);
    const [labelSize, setLabelSize] = useState<number | null>(null);
    const [labelResize, setLabelResize] = useState<number | null>(null);
    const dragging = useRef(false);
    const pasteRef = useRef<HTMLTextAreaElement>(null);

    const names = useMemo(() => columns.map((c) => c.name), [columns]);
    const visible = useMemo(() => displayOrder(names, layout), [names, layout]);
    const rowCount = cells.length;
    const colCount = visible.length;

    // Starting widths from the header and the first rows, for columns the layout has no width for.
    // Worked out once per set of columns, so widths don't jump between pages.
    const natural = useRef<{ key: string; widths: number[] } | null>(null);
    const columnsKey = names.join("\u0000");
    if (natural.current?.key !== columnsKey) {
        natural.current = {
            key: columnsKey,
            widths: columns.map((c, i) =>
                initialWidth(
                    c.name,
                    cells.slice(0, 50).map((row) => cellText(row[i] ?? null, c.type_name, options).text),
                    CHAR_WIDTH,
                ),
            ),
        };
    }
    const naturalWidths = natural.current.widths;

    const widthOf = (index: number) => {
        const name = names[index] ?? "";
        if (resizing?.name === name) return resizing.width;
        return layout.widths[name] ?? naturalWidths[index] ?? 120;
    };

    /** What a cell shows: a staged value or DEFAULT when editing, else the page value. */
    const shown = (row: number, index: number): { text: string; kind: string; title?: string } => {
        const column = columns[index];
        const staged: CellDisplay | undefined = editing?.display(row, index);
        if (staged?.kind === "default") return { text: staged.text, kind: "default", title: "DEFAULT" };
        const cell = staged ? staged.cell : (cells[row]?.[index] ?? null);
        return cellText(cell, column?.type_name ?? "", options);
    };

    const lefts: number[] = [];
    let total = 0;
    for (const index of visible) {
        lefts.push(total);
        total += widthOf(index);
    }

    const lastRowNumber = rowOffset + rowCount;
    const gutter = Math.max(44, String(lastRowNumber).length * 8 + 20);

    // Transposed: field labels down the left, one record per column, all records one width.
    const autoLabelWidth = clampTo(
        Math.max(
            0,
            ...visible.map((i) => {
                const c = columns[i];
                return c ? c.name.length * CHAR_WIDTH + c.type_name.length * 6 + 48 : 0;
            }),
        ),
        100,
        240,
    );
    const labelWidth = labelResize ?? labelSize ?? autoLabelWidth;
    const autoRecordWidth = clampTo(
        Math.max(0, ...visible.map((i) => naturalWidths[i] ?? 0)),
        MIN_RECORD_WIDTH,
        MAX_RECORD_WIDTH,
    );
    const recWidth = recordResize ?? recordWidth ?? autoRecordWidth;

    // The grid as drawn: in transposed mode a screen row is a column and a screen column is a row.
    const screenRows = transposed ? colCount : rowCount;
    const screenCols = transposed ? rowCount : colCount;
    const swap = (s: Selection): Selection => (transposed ? { anchor: flip(s.anchor), focus: flip(s.focus) } : s);
    /** Where cell (row, display column) sits on the canvas. */
    const cellBox = (row: number, col: number) =>
        transposed
            ? { left: labelWidth + row * recWidth, top: HEADER_HEIGHT + col * ROW_HEIGHT, width: recWidth }
            : {
                  left: gutter + (lefts[col] ?? 0),
                  top: HEADER_HEIGHT + row * ROW_HEIGHT,
                  width: widthOf(visible[col] ?? 0),
              };

    useLayoutEffect(() => {
        const el = scrollRef.current;
        if (!el) return;
        const update = () =>
            setViewport({ top: el.scrollTop, left: el.scrollLeft, width: el.clientWidth, height: el.clientHeight });
        update();
        const observer = new ResizeObserver(update);
        observer.observe(el);
        return () => observer.disconnect();
    }, []);

    // Keep the active cell in view.
    const focusRow = selection.focus.row;
    const focusCol = selection.focus.col;
    // biome-ignore lint/correctness/useExhaustiveDependencies: scroll only when the focus cell moves
    useEffect(() => {
        const el = scrollRef.current;
        if (!el || rowCount === 0 || colCount === 0) return;
        const { top, left, width } = cellBox(focusRow, focusCol);
        if (top < el.scrollTop + HEADER_HEIGHT) el.scrollTop = top - HEADER_HEIGHT;
        else if (top + ROW_HEIGHT > el.scrollTop + el.clientHeight) el.scrollTop = top + ROW_HEIGHT - el.clientHeight;

        const stickyLeft = transposed ? labelWidth : gutter;
        if (left < el.scrollLeft + stickyLeft) el.scrollLeft = left - stickyLeft;
        else if (left + width > el.scrollLeft + el.clientWidth) el.scrollLeft = left + width - el.clientWidth;
    }, [focusRow, focusCol, rowCount, colCount, transposed]);

    useEffect(() => {
        const stop = () => {
            dragging.current = false;
        };
        window.addEventListener("mouseup", stop);
        return () => window.removeEventListener("mouseup", stop);
    }, []);

    // Virtualized: the screen rows and columns in or near the viewport.
    const firstRow = Math.max(0, Math.floor((viewport.top - HEADER_HEIGHT) / ROW_HEIGHT) - OVERSCAN_ROWS);
    const lastRow = Math.min(screenRows - 1, Math.ceil((viewport.top + viewport.height) / ROW_HEIGHT) + OVERSCAN_ROWS);
    const shownCols: number[] = [];
    if (transposed) {
        const from = Math.max(0, Math.floor((viewport.left - OVERSCAN_PX) / recWidth) - 1);
        const to = Math.min(rowCount - 1, Math.ceil((viewport.left + viewport.width + OVERSCAN_PX) / recWidth));
        for (let r = from; r <= to; r++) shownCols.push(r);
    } else {
        for (let d = 0; d < colCount; d++) {
            const left = (lefts[d] ?? 0) + gutter;
            const right = left + widthOf(visible[d] ?? 0);
            if (right >= viewport.left - OVERSCAN_PX && left <= viewport.left + viewport.width + OVERSCAN_PX) {
                shownCols.push(d);
            }
        }
    }

    const range = rangeOf(selection);
    const pageRows = Math.max(1, Math.floor((viewport.height - HEADER_HEIGHT) / ROW_HEIGHT) - 1);
    const cellId = (row: number, col: number) => `${id}-r${row}-c${col}`;
    const activeId =
        rowCount > 0 && colCount > 0 && focusRow < rowCount && focusCol < colCount
            ? cellId(focusRow, focusCol)
            : undefined;

    const selected = () => {
        const { rows, cols } = spans(range);
        return {
            rows: rows.filter((r) => r < rowCount),
            columns: cols.map((d) => visible[d]).filter((c): c is number => c !== undefined),
        };
    };

    const copy = (format: CopyFormat) => {
        const { rows, columns: picked } = selected();
        // INSERT and JSON copy whole rows: every visible column.
        const whole = format === "insert" || format === "json";
        if (rows.length > 0) onCopy(format, rows, whole ? visible : picked);
    };

    const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
        if (rowCount === 0 || colCount === 0) return;
        const mod = e.metaKey || e.ctrlKey;
        const extend = e.shiftKey;
        // Keys move over the grid as drawn, so arrows follow the screen when transposed.
        const s = swap(selection);
        const { row, col } = s.focus;
        const rows = screenRows;
        const cols = screenCols;
        const go = (next: Selection) => {
            e.preventDefault();
            onSelectionChange(swap(next));
        };

        if (editing && editKey(e)) return;

        switch (e.key) {
            case "ArrowDown":
                return go(
                    mod ? moveTo(s, { row: rows - 1, col }, extend, rows, cols) : moveBy(s, 1, 0, extend, rows, cols),
                );
            case "ArrowUp":
                return go(mod ? moveTo(s, { row: 0, col }, extend, rows, cols) : moveBy(s, -1, 0, extend, rows, cols));
            case "ArrowRight":
                return go(
                    mod ? moveTo(s, { row, col: cols - 1 }, extend, rows, cols) : moveBy(s, 0, 1, extend, rows, cols),
                );
            case "ArrowLeft":
                return go(mod ? moveTo(s, { row, col: 0 }, extend, rows, cols) : moveBy(s, 0, -1, extend, rows, cols));
            case "Home":
                return go(moveTo(s, { row: mod ? 0 : row, col: 0 }, extend, rows, cols));
            case "End":
                return go(moveTo(s, { row: mod ? rows - 1 : row, col: cols - 1 }, extend, rows, cols));
            case "PageDown":
                return go(moveBy(s, pageRows, 0, extend, rows, cols));
            case "PageUp":
                return go(moveBy(s, -pageRows, 0, extend, rows, cols));
            case "ContextMenu":
                e.preventDefault();
                openMenuAtFocus();
                return;
        }

        if (e.key === "F10" && e.shiftKey) {
            e.preventDefault();
            openMenuAtFocus();
        } else if (mod && e.key.toLowerCase() === "a") {
            go(selectAll(rows, cols));
        } else if (mod && e.key.toLowerCase() === "c") {
            e.preventDefault();
            copy(e.shiftKey ? "tsv-with-headers" : "tsv");
        }
    };

    const act = (action: GridAction) => editing?.onAction(action);

    /** Opens the focus cell's editor; `initial` replaces the value (typing a character). */
    const startEdit = (initial?: string) => {
        if (!editing) return false;
        const column = visible[focusCol];
        if (column === undefined || focusRow >= rowCount) return false;
        const how = editing.edit(focusRow, column);
        if (!how) return false;
        if (how.kind === "toggle") {
            if (initial === undefined || initial === " ") act({ kind: "toggle", row: focusRow, column });
            return true;
        }
        if (how.kind === "inspector") {
            act({ kind: "inspect" });
            return true;
        }
        setEditor({
            row: focusRow,
            col: focusCol,
            spec: initial === undefined ? how.spec : { ...how.spec, initial, replaced: true, load: undefined },
        });
        return true;
    };

    /** Editing keys; returns true when the key was handled. */
    const editKey = (e: KeyboardEvent<HTMLDivElement>): boolean => {
        const mod = e.metaKey || e.ctrlKey;
        const key = e.key.toLowerCase();
        const handled = (action?: GridAction) => {
            e.preventDefault();
            if (action) act(action);
            return true;
        };
        if (!mod && !e.altKey && (e.key === "Enter" || e.key === "F2")) {
            return startEdit() ? handled() : false;
        }
        if (!mod && (e.key === "Delete" || e.key === "Backspace")) return handled({ kind: "set-null" });
        if (mod && e.key === "Backspace") return handled({ kind: "delete-rows" });
        if (mod && !e.shiftKey && key === "d") return handled({ kind: "fill-down" });
        if (mod && e.shiftKey && key === "n") return handled({ kind: "add-row" });
        if (mod && key === "z") return handled({ kind: e.shiftKey ? "redo" : "undo" });
        if (mod && !e.shiftKey && key === "y") return handled({ kind: "redo" });
        if (mod && key === "v") {
            // The paste lands in a hidden textarea, whose paste event reads the clipboard.
            pasteRef.current?.focus();
            return true;
        }
        if (!mod && !e.altKey && e.key.length === 1) {
            return startEdit(e.key) ? handled() : false;
        }
        return false;
    };

    const finishEdit = (text: string | null | undefined, move: EditorMove, all: boolean) => {
        if (!editor) return;
        const column = visible[editor.col];
        setEditor(null);
        if (column !== undefined && text !== undefined) act({ kind: "commit", row: editor.row, column, text, all });
        scrollRef.current?.focus({ preventScroll: true });
        // Enter and Tab move down and right on the screen.
        const by = { down: [1, 0], right: [0, 1], left: [0, -1], none: [0, 0] }[move];
        if (move !== "none") {
            const from = swap(at(editor.row, editor.col));
            onSelectionChange(swap(moveBy(from, by[0] ?? 0, by[1] ?? 0, false, screenRows, screenCols)));
        }
    };

    const openMenuAtFocus = () => {
        const el = activeId ? document.getElementById(activeId) : null;
        const rect = el?.getBoundingClientRect();
        setMenu({
            x: rect ? rect.left + 8 : 100,
            y: rect ? rect.bottom : 100,
            column: visible[focusCol] ?? 0,
            header: false,
        });
    };

    const onCellMouseDown = (e: MouseEvent, row: number, col: number) => {
        if (e.button !== 0) return;
        if (e.detail === 2 && editing && !e.shiftKey) {
            e.preventDefault();
            onSelectionChange(at(row, col));
            requestAnimationFrame(() => startEditAt(row, col));
            return;
        }
        scrollRef.current?.focus({ preventScroll: true });
        dragging.current = true;
        onSelectionChange(e.shiftKey ? moveTo(selection, { row, col }, true, rowCount, colCount) : at(row, col));
    };

    const startEditAt = (row: number, col: number) => {
        if (!editing) return;
        const column = visible[col];
        if (column === undefined) return;
        const how = editing.edit(row, column);
        if (how?.kind === "editor") setEditor({ row, col, spec: how.spec });
        else if (how?.kind === "toggle") act({ kind: "toggle", row, column });
        else if (how?.kind === "inspector") act({ kind: "inspect" });
    };

    const onCellContextMenu = (e: MouseEvent, row: number, col: number) => {
        e.preventDefault();
        if (!contains(range, row, col)) onSelectionChange(at(row, col));
        setMenu({ x: e.clientX, y: e.clientY, column: visible[col] ?? 0, header: false });
    };

    const fitColumn = (index: number) => {
        const font = scrollRef.current ? getComputedStyle(scrollRef.current).font : "12px monospace";
        const column = columns[index];
        if (!column) return;
        const widest = Math.max(
            textWidth(column.name, font) + 40,
            ...cells.map((_, r) => textWidth(shown(r, index).text, font) + 20),
        );
        onLayoutChange(setWidth(layout, column.name, widest));
    };

    const startResize = (e: MouseEvent, index: number) => {
        e.preventDefault();
        e.stopPropagation();
        const name = names[index] ?? "";
        const startX = e.clientX;
        const startWidth = widthOf(index);
        let width = startWidth;
        const move = (ev: globalThis.MouseEvent) => {
            width = Math.max(48, startWidth + ev.clientX - startX);
            setResizing({ name, width });
        };
        const up = () => {
            window.removeEventListener("mousemove", move);
            window.removeEventListener("mouseup", up);
            setResizing(null);
            if (width !== startWidth) onLayoutChange(setWidth(layout, name, width));
        };
        window.addEventListener("mousemove", move);
        window.addEventListener("mouseup", up);
    };

    /** Drags a transposed-mode width: `preview` follows the mouse, `commit` keeps the result. */
    const dragWidth = (
        e: MouseEvent,
        startWidth: number,
        preview: (width: number | null) => void,
        commit: (width: number) => void,
    ) => {
        e.preventDefault();
        e.stopPropagation();
        const startX = e.clientX;
        let width = startWidth;
        const move = (ev: globalThis.MouseEvent) => {
            width = clampTo(startWidth + ev.clientX - startX, 48, 640);
            preview(width);
        };
        const up = () => {
            window.removeEventListener("mousemove", move);
            window.removeEventListener("mouseup", up);
            preview(null);
            if (width !== startWidth) commit(width);
        };
        window.addEventListener("mousemove", move);
        window.addEventListener("mouseup", up);
    };

    const dropOn = (target: string, after: boolean, dragged: string) => {
        if (dragged === target) return;
        const all = displayOrder(names, layout, true).map((i) => names[i] ?? "");
        const without = all.filter((n) => n !== dragged);
        const to = without.indexOf(target) + (after ? 1 : 0);
        onLayoutChange(moveColumn(names, layout, dragged, to));
    };

    const menuEntries = (column: number, header: boolean): MenuEntry[] => {
        const name = names[column] ?? "";
        const columnEntries: MenuEntry[] = [
            { label: "Copy column name", onSelect: () => void navigator.clipboard.writeText(name).catch(() => {}) },
            ...(onOrderChange
                ? ([
                      { label: "Sort ascending", onSelect: () => onOrderChange(sortBy(name, "asc")) },
                      { label: "Sort descending", onSelect: () => onOrderChange(sortBy(name, "desc")) },
                      "separator",
                  ] as MenuEntry[])
                : []),
            {
                label: transposed ? "Move up" : "Move left",
                onSelect: () => onLayoutChange(shiftColumn(names, layout, name, -1)),
            },
            {
                label: transposed ? "Move down" : "Move right",
                onSelect: () => onLayoutChange(shiftColumn(names, layout, name, 1)),
            },
            ...(transposed ? [] : [{ label: "Fit width", onSelect: () => fitColumn(column) }]),
            {
                label: "Hide column",
                disabled: colCount <= 1,
                onSelect: () => onLayoutChange(setHidden(layout, name, true)),
            },
        ];
        if (header) return columnEntries;
        const editEntries: MenuEntry[] = editing
            ? [
                  { label: "Edit", hint: "⏎", onSelect: () => startEdit() },
                  { label: "Set to NULL", hint: "⌫", onSelect: () => act({ kind: "set-null" }) },
                  { label: "Set to DEFAULT", onSelect: () => act({ kind: "set-default" }) },
                  { label: "Fill down", hint: "⌘D", onSelect: () => act({ kind: "fill-down" }) },
                  { label: "Revert", onSelect: () => act({ kind: "revert" }) },
                  "separator",
                  { label: "Add row", hint: "⇧⌘N", onSelect: () => act({ kind: "add-row" }) },
                  { label: "Duplicate rows", onSelect: () => act({ kind: "duplicate-rows" }) },
                  { label: "Delete rows", hint: "⌘⌫", danger: true, onSelect: () => act({ kind: "delete-rows" }) },
                  "separator",
              ]
            : [];
        return [
            ...editEntries,
            { label: "Copy", hint: "⌘C", onSelect: () => copy("tsv") },
            { label: "Copy with headers", hint: "⇧⌘C", onSelect: () => copy("tsv-with-headers") },
            { label: "Copy rows as INSERT", onSelect: () => copy("insert") },
            { label: "Copy rows as JSON", onSelect: () => copy("json") },
            "separator",
            ...columnEntries,
        ];
    };

    const height = HEADER_HEIGHT + screenRows * ROW_HEIGHT;
    const width = transposed ? labelWidth + rowCount * recWidth : gutter + total;
    const capped = maxRows ? { maxHeight: HEADER_HEIGHT + Math.min(screenRows, maxRows) * ROW_HEIGHT + 14 } : undefined;

    const rowStateOf = (r: number) => editing?.rowState(r) ?? null;
    const rowDescription = (state: ReturnType<GridEditing["rowState"]> | null) =>
        state === "deleted"
            ? "will be deleted"
            : state === "inserted"
              ? "new row"
              : state === "updated"
                ? "edited"
                : undefined;
    /** The row number shown in the gutter (or the record header when transposed). */
    const rowNumberOf = (r: number) => {
        const state = rowStateOf(r);
        if (state === "deleted") return "−";
        if (state === "inserted") return "+";
        return editing?.rowLabel(r) ?? rowOffset + r + 1;
    };

    /** A column header's name, type, key and sort marks: the top header, or the left label when transposed. */
    const headerContent = (column: Column) => {
        const sort = sortOf(order, column.name);
        return (
            <>
                {keyColumns.has(column.name) && <KeyRound size={11} className={styles.key} aria-label="Primary key" />}
                <span className={styles.headerName}>{column.name}</span>
                <span className={styles.headerType}>{column.type_name.toLowerCase()}</span>
                {sort &&
                    (sort.direction === "asc" ? (
                        <ArrowUp size={11} className={styles.sort} />
                    ) : (
                        <ArrowDown size={11} className={styles.sort} />
                    ))}
                {sort && order.includes(",") && <span className={styles.sortPosition}>{sort.position}</span>}
            </>
        );
    };

    /** Sorting, the header menu and drag-to-reorder for a column header; drops land along `axis`. */
    const headerProps = (column: Column, index: number) => {
        const sort = sortOf(order, column.name);
        const drop = dropTarget?.name === column.name ? dropTarget : null;
        const isAfter = (e: DragEvent<HTMLElement>) => {
            const rect = e.currentTarget.getBoundingClientRect();
            return transposed ? e.clientY > rect.top + rect.height / 2 : e.clientX > rect.left + rect.width / 2;
        };
        return {
            "aria-sort": sort ? (sort.direction === "asc" ? "ascending" : "descending") : undefined,
            "data-numeric": (!transposed && isNumeric(column.type_name)) || undefined,
            "data-drop": drop ? (drop.after ? "after" : "before") : undefined,
            title: onOrderChange
                ? `${column.name} · ${column.type_name}\nClick to sort, Shift-click to add a sort`
                : `${column.name} · ${column.type_name}`,
            draggable: true,
            onClick: (e: MouseEvent) => onOrderChange?.(cycleSort(order, column.name, e.shiftKey)),
            onContextMenu: (e: MouseEvent) => {
                e.preventDefault();
                setMenu({ x: e.clientX, y: e.clientY, column: index, header: true });
            },
            onDragStart: (e: DragEvent<HTMLElement>) => {
                e.dataTransfer.setData("text/x-dbrief-column", column.name);
                e.dataTransfer.effectAllowed = "move";
            },
            onDragOver: (e: DragEvent<HTMLElement>) => {
                if (!e.dataTransfer.types.includes("text/x-dbrief-column")) return;
                e.preventDefault();
                const after = isAfter(e);
                if (drop?.after !== after) setDropTarget({ name: column.name, after });
            },
            onDragLeave: () => setDropTarget(null),
            onDrop: (e: DragEvent<HTMLElement>) => {
                e.preventDefault();
                setDropTarget(null);
                const dragged = e.dataTransfer.getData("text/x-dbrief-column");
                if (dragged) dropOn(column.name, isAfter(e), dragged);
            },
        } as const;
    };

    /** Cell (row, display column), placed at `style`; `ariaCol` is its column index as drawn. */
    const renderCell = (r: number, d: number, ariaCol: number, style: CSSProperties) => {
        const index = visible[d] ?? 0;
        const column = columns[index];
        const { text, kind, title } = shown(r, index);
        const key = `${r}:${index}`;
        const isSelected = contains(range, r, d);
        const edited = editing?.edited(r, index) ?? false;
        const readOnly = editing ? !editing.edit(r, index) : undefined;
        const state = rowStateOf(r);
        return (
            // biome-ignore lint/a11y/useFocusableInteractive: focus stays on the grid (aria-activedescendant)
            // biome-ignore lint/a11y/useSemanticElements: virtualized grid cells
            <div
                key={transposed ? r : index}
                id={cellId(r, d)}
                role="gridcell"
                aria-colindex={ariaCol}
                aria-selected={isSelected}
                aria-readonly={readOnly || undefined}
                aria-description={edited ? "edited" : transposed ? rowDescription(state) : undefined}
                className={styles.cell}
                title={title}
                data-kind={kind}
                data-state={state ?? undefined}
                data-edited={edited || undefined}
                data-null-style={kind === "null" ? options.nullDisplay : undefined}
                data-numeric={(!transposed && column && isNumeric(column.type_name)) || undefined}
                data-selected={isSelected || undefined}
                data-active={(r === focusRow && d === focusCol) || undefined}
                data-match={matches.has(key) || undefined}
                data-current-match={currentMatch === key || undefined}
                style={style}
                onMouseDown={(e) => onCellMouseDown(e, r, d)}
                onMouseEnter={() => {
                    if (dragging.current) {
                        onSelectionChange(moveTo(selection, { row: r, col: d }, true, rowCount, colCount));
                    }
                }}
                onContextMenu={(e) => onCellContextMenu(e, r, d)}
            >
                {kind === "null" && options.nullDisplay === "blank" ? (
                    <span className="visually-hidden">NULL</span>
                ) : (
                    text
                )}
            </div>
        );
    };

    const screenRowList = Array.from({ length: Math.max(0, lastRow - firstRow + 1) }, (_, k) => firstRow + k);

    // Rows across, columns down: a header of row numbers, then one screen row per column.
    const transposedBody = () => (
        <>
            {/* biome-ignore lint/a11y/useSemanticElements: virtualized grid rows */}
            {/* biome-ignore lint/a11y/useFocusableInteractive: focus stays on the grid */}
            <div className={styles.headerRow} role="row" aria-rowindex={1} style={{ width }}>
                <div className={styles.corner} style={{ width: labelWidth }} />
                {shownCols.map((r) => {
                    const state = rowStateOf(r);
                    return (
                        <div key={r}>
                            {/* biome-ignore lint/a11y/useSemanticElements: virtualized grid header */}
                            {/* biome-ignore lint/a11y/useFocusableInteractive: focus stays on the grid */}
                            <div
                                role="columnheader"
                                aria-colindex={r + 2}
                                aria-description={rowDescription(state)}
                                className={styles.recordHeader}
                                data-state={state ?? undefined}
                                style={{ left: labelWidth + r * recWidth, width: recWidth }}
                            >
                                {rowNumberOf(r)}
                            </div>
                            {/* biome-ignore lint/a11y/noStaticElementInteractions: mouse-only; double-click resets the width */}
                            <div
                                className={styles.resize}
                                style={{ left: labelWidth + (r + 1) * recWidth - 3 }}
                                onMouseDown={(e) => dragWidth(e, recWidth, setRecordResize, setRecordWidth)}
                                onDoubleClick={() => setRecordWidth(null)}
                            />
                        </div>
                    );
                })}
            </div>

            {screenRowList.map((d) => {
                const index = visible[d] ?? 0;
                const column = columns[index];
                if (!column) return null;
                return (
                    // biome-ignore lint/a11y/useSemanticElements: virtualized grid rows
                    // biome-ignore lint/a11y/useFocusableInteractive: focus stays on the grid
                    <div
                        key={index}
                        role="row"
                        aria-rowindex={d + 2}
                        className={styles.row}
                        style={{ top: HEADER_HEIGHT + d * ROW_HEIGHT, width }}
                    >
                        {/* biome-ignore lint/a11y/useSemanticElements: virtualized grid header */}
                        {/* biome-ignore lint/a11y/useFocusableInteractive: focus stays on the grid; sorting by keyboard is in the cell menu */}
                        <div
                            role="rowheader"
                            aria-colindex={1}
                            className={styles.fieldLabel}
                            style={{ width: labelWidth }}
                            {...headerProps(column, index)}
                        >
                            {headerContent(column)}
                        </div>
                        {shownCols.map((r) =>
                            renderCell(r, d, r + 2, { left: labelWidth + r * recWidth, width: recWidth }),
                        )}
                    </div>
                );
            })}
        </>
    );

    const normalBody = () => (
        <>
            {/* biome-ignore lint/a11y/useSemanticElements: virtualized grid rows */}
            {/* biome-ignore lint/a11y/useFocusableInteractive: focus stays on the grid */}
            <div className={styles.headerRow} role="row" aria-rowindex={1} style={{ width }}>
                <div className={styles.corner} style={{ width: gutter }} />
                {shownCols.map((d) => {
                    const index = visible[d] ?? 0;
                    const column = columns[index];
                    if (!column) return null;
                    return (
                        <div key={index}>
                            {/* biome-ignore lint/a11y/useSemanticElements: virtualized grid header */}
                            {/* biome-ignore lint/a11y/useFocusableInteractive: focus stays on the grid; sorting by keyboard is in the cell menu */}
                            <div
                                role="columnheader"
                                aria-colindex={d + 1}
                                className={styles.header}
                                style={{ left: gutter + (lefts[d] ?? 0), width: widthOf(index) }}
                                {...headerProps(column, index)}
                            >
                                {headerContent(column)}
                            </div>
                            {/* biome-ignore lint/a11y/noStaticElementInteractions: mouse-only; the header menu's Fit width is the keyboard path */}
                            <div
                                className={styles.resize}
                                style={{ left: gutter + (lefts[d] ?? 0) + widthOf(index) - 3 }}
                                onMouseDown={(e) => startResize(e, index)}
                                onDoubleClick={() => fitColumn(index)}
                            />
                        </div>
                    );
                })}
            </div>

            {screenRowList.map((r) => {
                if (!cells[r]) return null;
                const state = rowStateOf(r);
                const label = editing?.rowLabel(r) ?? null;
                return (
                    // biome-ignore lint/a11y/useSemanticElements: virtualized grid rows
                    // biome-ignore lint/a11y/useFocusableInteractive: focus stays on the grid
                    <div
                        key={r}
                        role="row"
                        aria-rowindex={r + 2}
                        aria-description={rowDescription(state)}
                        className={styles.row}
                        style={{ top: HEADER_HEIGHT + r * ROW_HEIGHT, width }}
                    >
                        <div
                            className={styles.rowNumber}
                            data-state={state ?? undefined}
                            style={{ width: gutter }}
                            aria-hidden
                            title={state === "inserted" ? `New row ${label ?? ""}` : undefined}
                        >
                            {rowNumberOf(r)}
                        </div>
                        {shownCols.map((d) =>
                            renderCell(r, d, d + 1, {
                                left: gutter + (lefts[d] ?? 0),
                                width: widthOf(visible[d] ?? 0),
                            }),
                        )}
                    </div>
                );
            })}
        </>
    );

    const stickyLeft = transposed ? labelWidth : 0;

    return (
        <div className={styles.frame} data-capped={maxRows ? true : undefined}>
            {/* Virtualized: rows and cells are positioned divs, so <table> elements can't be used. The
                grid takes focus and moves its active cell with aria-activedescendant. */}
            {/* biome-ignore lint/a11y/useSemanticElements: see above */}
            <div
                ref={scrollRef}
                className={styles.scroll}
                role="grid"
                aria-label={label}
                aria-rowcount={screenRows + 1}
                aria-colcount={transposed ? rowCount + 1 : colCount}
                aria-multiselectable
                aria-readonly={!editing}
                aria-activedescendant={editor ? undefined : activeId}
                tabIndex={0}
                style={capped}
                data-capped={maxRows ? true : undefined}
                data-transposed={transposed || undefined}
                onKeyDown={onKeyDown}
                onScroll={(e) => {
                    const el = e.currentTarget;
                    setViewport((v) => ({ ...v, top: el.scrollTop, left: el.scrollLeft }));
                }}
            >
                <div className={styles.canvas} style={{ width, height }}>
                    {transposed ? transposedBody() : normalBody()}
                    {editor && (
                        <CellEditor
                            key={`${editor.row}:${editor.col}`}
                            spec={editor.spec}
                            {...cellBox(editor.row, editor.col)}
                            height={ROW_HEIGHT}
                            onCommit={finishEdit}
                            onCancel={() => {
                                setEditor(null);
                                scrollRef.current?.focus({ preventScroll: true });
                            }}
                        />
                    )}
                </div>
                {rowCount === 0 && (
                    // Centered in the visible part of the columns: the viewport, or less when they're narrower.
                    // Transposed, it sits right of the field labels.
                    <p
                        className={styles.empty}
                        data-transposed={transposed || undefined}
                        style={{
                            left: viewport.left + stickyLeft,
                            width: transposed
                                ? Math.max(0, viewport.width - stickyLeft)
                                : Math.max(0, Math.min(viewport.width, width - viewport.left)),
                        }}
                    >
                        No rows
                    </p>
                )}
            </div>
            {transposed && (
                // One line down the field labels' edge, drawn like the panel splitters. It sits over the
                // grid, outside the scrolled content, so the cell borders don't cross it.
                // biome-ignore lint/a11y/noStaticElementInteractions: mouse-only; double-click resets the width
                <div
                    className={styles.labelResize}
                    data-active={labelResize !== null || undefined}
                    style={{ left: labelWidth - 1, height: Math.min(height, viewport.height) }}
                    onMouseDown={(e) => dragWidth(e, labelWidth, setLabelResize, setLabelSize)}
                    onDoubleClick={() => setLabelSize(null)}
                />
            )}
            {editing && (
                <textarea
                    ref={pasteRef}
                    className="visually-hidden"
                    tabIndex={-1}
                    aria-hidden
                    onPaste={(e) => {
                        e.preventDefault();
                        const text = e.clipboardData.getData("text/plain");
                        scrollRef.current?.focus({ preventScroll: true });
                        if (text) act({ kind: "paste", text });
                    }}
                    onBlur={(e) => {
                        e.currentTarget.value = "";
                    }}
                />
            )}
            {menu && (
                <ContextMenu
                    label={menu.header ? "Column" : "Cells"}
                    at={menu}
                    entries={menuEntries(menu.column, menu.header)}
                    onClose={() => setMenu(null)}
                    returnFocus={scrollRef.current}
                />
            )}
        </div>
    );
}
