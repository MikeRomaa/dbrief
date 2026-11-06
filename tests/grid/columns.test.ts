import { describe, expect, it } from "vitest";

import {
    displayOrder,
    EMPTY_LAYOUT,
    MAX_WIDTH,
    MIN_WIDTH,
    moveColumn,
    parseLayout,
    serializeLayout,
    setHidden,
    setWidth,
    shiftColumn,
} from "@/grid/columns";

const names = ["id", "name", "email", "created"];

describe("column layout", () => {
    it("keeps natural order without a layout", () => {
        expect(displayOrder(names, EMPTY_LAYOUT)).toEqual([0, 1, 2, 3]);
    });

    it("orders saved columns first and appends new ones", () => {
        const layout = { ...EMPTY_LAYOUT, order: ["email", "gone", "id"] };
        expect(displayOrder(names, layout)).toEqual([2, 0, 1, 3]);
    });

    it("hides columns, but moves count them", () => {
        let layout = setHidden(EMPTY_LAYOUT, "name", true);
        expect(displayOrder(names, layout)).toEqual([0, 2, 3]);
        expect(displayOrder(names, layout, true)).toEqual([0, 1, 2, 3]);

        layout = moveColumn(names, layout, "created", 0);
        expect(displayOrder(names, layout)).toEqual([3, 0, 2]);
        expect(displayOrder(names, setHidden(layout, "name", false))).toEqual([3, 0, 1, 2]);
    });

    it("shifts past hidden columns", () => {
        const layout = setHidden(EMPTY_LAYOUT, "name", true);
        const shifted = shiftColumn(names, layout, "id", 1);
        expect(displayOrder(names, shifted)).toEqual([2, 0, 3]);
        expect(shiftColumn(names, layout, "id", -1)).toBe(layout);
    });

    it("clamps widths", () => {
        expect(setWidth(EMPTY_LAYOUT, "id", 5).widths.id).toBe(MIN_WIDTH);
        expect(setWidth(EMPTY_LAYOUT, "id", 5000).widths.id).toBe(MAX_WIDTH);
    });

    it("round-trips and tolerates bad saved data", () => {
        const layout = setWidth(setHidden(EMPTY_LAYOUT, "a", true), "b", 100);
        expect(parseLayout(serializeLayout(layout))).toEqual(layout);
        expect(parseLayout("{nope")).toEqual(EMPTY_LAYOUT);
        expect(parseLayout('{"order": 3}')).toEqual(EMPTY_LAYOUT);
    });
});
