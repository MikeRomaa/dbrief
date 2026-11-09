import { describe, expect, it } from "vitest";

import {
    addRow,
    cellValue,
    counts,
    deleteRows,
    EMPTY_HISTORY,
    EMPTY_STAGING,
    hasFiles,
    indexOf,
    isEmpty,
    push,
    redo,
    revertCell,
    revertRow,
    rowAt,
    rowState,
    type StagedValue,
    setCell,
    summary,
    toChanges,
    undelete,
    undo,
} from "@/lib/grid/staging";

const text = (t: string) => ({ kind: "text", text: t }) as const;
const page = (row: number) => ({ kind: "page", row }) as const;

describe("staging", () => {
    it("stages and drops cell edits", () => {
        let s = setCell(EMPTY_STAGING, page(1), "name", text("x"));
        expect(cellValue(s, page(1), "name")).toEqual(text("x"));
        expect(rowState(s, page(1))).toBe("updated");

        // Editing back to the original drops the edit, and the row with it.
        s = setCell(s, page(1), "name", text("orig"), true);
        expect(cellValue(s, page(1), "name")).toBeUndefined();
        expect(rowState(s, page(1))).toBeNull();
        expect(isEmpty(s)).toBe(true);

        s = setCell(s, page(1), "a", text("1"));
        s = setCell(s, page(1), "b", { kind: "null" });
        s = revertCell(s, page(1), "a");
        expect(cellValue(s, page(1), "a")).toBeUndefined();
        expect(cellValue(s, page(1), "b")).toEqual({ kind: "null" });
    });

    it("keeps edits of a deleted row and blocks editing it", () => {
        let s = setCell(EMPTY_STAGING, page(0), "name", text("x"));
        s = deleteRows(s, [page(0)]);
        expect(rowState(s, page(0))).toBe("deleted");
        expect(setCell(s, page(0), "name", text("y"))).toBe(s);
        expect(counts(s)).toEqual({ updated: 0, inserted: 0, deleted: 1, total: 1 });
        expect(toChanges(s).changes).toEqual([{ kind: "delete", row: 0 }]);

        s = undelete(s, 0);
        expect(cellValue(s, page(0), "name")).toEqual(text("x"));
        s = revertRow(deleteRows(s, [page(0)]), page(0));
        expect(isEmpty(s)).toBe(true);
    });

    it("adds, edits and removes inserted rows", () => {
        let [s, ref] = addRow(
            EMPTY_STAGING,
            new Map<string, StagedValue>([
                ["a", { kind: "default" }],
                ["b", text("2")],
            ]),
        );
        expect(cellValue(s, ref, "a")).toBeUndefined();
        expect(cellValue(s, ref, "b")).toEqual(text("2"));
        s = setCell(s, ref, "a", text("1"));
        s = setCell(s, ref, "b", { kind: "default" });
        expect(cellValue(s, ref, "b")).toBeUndefined();

        expect(rowAt(s, 3, 3)).toEqual(ref);
        expect(rowAt(s, 3, 1)).toEqual(page(1));
        expect(rowAt(s, 3, 4)).toBeNull();
        expect(indexOf(s, 3, ref)).toBe(3);

        expect(rowState(s, ref)).toBe("inserted");
        s = deleteRows(s, [ref]);
        expect(rowState(s, ref)).toBeNull();
        expect(indexOf(s, 3, ref)).toBe(-1);
        expect(s.deletes.size).toBe(0);
    });

    it("builds changes in order with the row of each", () => {
        let s = setCell(EMPTY_STAGING, page(4), "n", text("1"));
        s = setCell(s, page(2), "n", { kind: "original", row: 0 });
        s = deleteRows(s, [page(7)]);
        const [withInsert, ref] = addRow(s, new Map([["f", { kind: "file", token: "t", size: 3, image: null }]]));
        const { changes, rows } = toChanges(withInsert);
        expect(changes).toEqual([
            { kind: "delete", row: 7 },
            { kind: "update", row: 2, values: [{ column: "n", value: { kind: "original", row: 0 } }] },
            { kind: "update", row: 4, values: [{ column: "n", value: text("1") }] },
            { kind: "insert", values: [{ column: "f", value: { kind: "file", token: "t" } }] },
        ]);
        expect(rows).toEqual([page(7), page(2), page(4), ref]);
        expect(hasFiles(withInsert)).toBe(true);
        expect(hasFiles(s)).toBe(false);
        expect(summary(counts(withInsert))).toBe("2 edits, 1 insert, 1 delete");
    });

    it("undoes and redoes", () => {
        let h = push(EMPTY_HISTORY, setCell(EMPTY_STAGING, page(0), "a", text("1")));
        h = push(h, setCell(h.current, page(0), "a", text("2")));
        expect(push(h, h.current)).toBe(h);
        h = undo(h);
        expect(cellValue(h.current, page(0), "a")).toEqual(text("1"));
        h = undo(undo(h));
        expect(isEmpty(h.current)).toBe(true);
        h = redo(h);
        expect(cellValue(h.current, page(0), "a")).toEqual(text("1"));
        h = push(h, EMPTY_STAGING);
        expect(h.future).toEqual([]);
    });
});
