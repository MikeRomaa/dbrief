import type { EditorKind } from "@/lib/grid/editors";
import type { StagedValue } from "@/lib/grid/staging";
import type { Cell, Column, Engine } from "@/lib/ipc/bindings";
import { Store } from "@/lib/util/store";

/**
 * What the inspector shows: the active grid cell. For a table tab, `sessionId` and `row` index the
 * session's loaded page (`row` is `null` for an inserted row, which has no page value); `column` is
 * the result column, not its display position. Script results have no session and pass their row's
 * `values` instead. `rowNumber` labels the row ("12", or "+1" for an inserted row).
 *
 * `edit` is set when the cell can be edited, and `editFor` gives the same for each column of the
 * row (the Row tab).
 */
export interface InspectorTarget {
    sessionId: string | null;
    columns: Column[];
    cells: (Cell | null)[];
    values?: (string | null)[];
    row: number | null;
    column: number;
    rowNumber: string;
    edit?: InspectorEdit | null;
    editFor?: (column: number) => InspectorEdit | null;
}

/**
 * Editing one cell from the inspector. `staged` is the cell's staged value (`undefined` when it
 * isn't edited); `defaultText` is what DEFAULT shows for an inserted row's cell.
 */
export interface InspectorEdit {
    kind: EditorKind;
    typeName: string;
    engine: Engine;
    nullable: boolean;
    staged: StagedValue | undefined;
    defaultText: string | null;
    stage: (value: StagedValue) => void;
    revert: () => void;
    upload: () => Promise<void>;
}

export const inspectorTarget = new Store<InspectorTarget | null>(null);
