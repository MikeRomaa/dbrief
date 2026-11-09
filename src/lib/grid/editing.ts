import type { EditorSpec } from "@/lib/grid/editors";
import type { RowState } from "@/lib/grid/staging";
import type { Cell } from "@/lib/ipc/bindings";

/**
 * How an editable grid is driven. The grid shows staged values and marks, opens editors, and turns
 * keys and menu entries into actions; the table tab owns the staged changes and acts on them,
 * reading the selection it already holds. `row` is a grid row (page rows, then inserted rows) and
 * `column` a result column index.
 */
export type CellDisplay = { kind: "value"; cell: Cell | null } | { kind: "default"; text: string };

/** How a cell edits: in the cell, by toggling (booleans), in the inspector, or not at all (`null`). */
export type CellEdit = { kind: "editor"; spec: EditorSpec } | { kind: "toggle" } | { kind: "inspector" } | null;

export type GridAction =
    | { kind: "commit"; row: number; column: number; text: string | null; all: boolean }
    | { kind: "toggle"; row: number; column: number }
    | { kind: "inspect" }
    | { kind: "set-null" }
    | { kind: "set-default" }
    | { kind: "fill-down" }
    | { kind: "add-row" }
    | { kind: "duplicate-rows" }
    | { kind: "delete-rows" }
    | { kind: "revert" }
    | { kind: "paste"; text: string }
    | { kind: "undo" }
    | { kind: "redo" };

export interface GridEditing {
    display: (row: number, column: number) => CellDisplay | undefined;
    rowState: (row: number) => RowState;
    /** The gutter label of an inserted row ("+1"); `null` for page rows. */
    rowLabel: (row: number) => string | null;
    edited: (row: number, column: number) => boolean;
    edit: (row: number, column: number) => CellEdit;
    onAction: (action: GridAction) => void;
}
