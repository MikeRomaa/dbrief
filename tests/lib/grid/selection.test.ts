import { describe, expect, it } from "vitest";

import { at, contains, moveBy, moveTo, rangeOf, selectAll, spans } from "@/lib/grid/selection";

describe("grid selection", () => {
    it("moves and clamps the active cell", () => {
        const s = moveBy(at(0, 0), -1, 5, false, 10, 3);
        expect(s.focus).toEqual({ row: 0, col: 2 });
        expect(s.anchor).toEqual(s.focus);
    });

    it("extends from the anchor", () => {
        const s = moveTo(at(5, 2), { row: 1, col: 0 }, true, 10, 3);
        expect(rangeOf(s)).toEqual({ top: 1, bottom: 5, left: 0, right: 2 });
        expect(contains(rangeOf(s), 3, 1)).toBe(true);
        expect(contains(rangeOf(s), 6, 1)).toBe(false);
    });

    it("selects everything and lists spans", () => {
        const range = rangeOf(selectAll(3, 2));
        expect(spans(range)).toEqual({ rows: [0, 1, 2], cols: [0, 1] });
    });
});
