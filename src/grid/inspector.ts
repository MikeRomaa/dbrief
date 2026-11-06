import type { Cell, Column } from "@/lib/bindings";
import { Store } from "@/lib/store";

/**
 * What the inspector shows: the active grid cell of a table tab. `row` and `column` index the
 * session's loaded page (the column is the result column, not its display position); `rowNumber` is
 * the row's number in the table view (1-based, across pages).
 */
export interface InspectorTarget {
    sessionId: string;
    columns: Column[];
    cells: (Cell | null)[];
    row: number;
    column: number;
    rowNumber: number;
}

export const inspectorTarget = new Store<InspectorTarget | null>(null);
