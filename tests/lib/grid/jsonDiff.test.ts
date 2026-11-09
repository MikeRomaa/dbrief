import { describe, expect, it } from "vitest";

import { changedLines, jsonChanges } from "@/lib/grid/jsonDiff";

const lines = (value: unknown) => JSON.stringify(value, null, 2).split("\n");

describe("changedLines", () => {
    it("marks a changed value's line", () => {
        expect(
            changedLines(lines({ tier: 3, seats: null, sso: true }), lines({ tier: 3, seats: 250, sso: true })),
        ).toEqual([3]);
    });

    it("marks added lines and not the ones after them", () => {
        expect(changedLines(["{", '  "a": 1', "}"], ["{", '  "a": 1,', '  "b": 2', "}"])).toEqual([2, 3]);
    });

    it("marks nothing when only lines were removed", () => {
        expect(changedLines(["a", "b", "c"], ["a", "c"])).toEqual([]);
    });
});

describe("jsonChanges", () => {
    it("lists a changed key by its path", () => {
        expect(jsonChanges({ seats: null, tier: 3 }, { seats: 250, tier: 3 })).toEqual([
            { path: "seats", before: null, after: 250 },
        ]);
    });

    it("walks into nested objects and arrays", () => {
        expect(jsonChanges({ a: { b: [1, 2] } }, { a: { b: [1, 3, 4] } })).toEqual([
            { path: "a.b[1]", before: 2, after: 3 },
            { path: "a.b[2]", before: undefined, after: 4 },
        ]);
    });

    it("lists added and removed keys, quoting names that need it", () => {
        expect(jsonChanges({ x: 1 }, { "my key": 2 })).toEqual([
            { path: "x", before: 1, after: undefined },
            { path: '"my key"', before: undefined, after: 2 },
        ]);
    });

    it("lists a changed root as $", () => {
        expect(jsonChanges([1], { a: 1 })).toEqual([{ path: "$", before: [1], after: { a: 1 } }]);
        expect(jsonChanges({ a: 1 }, { a: 1 })).toEqual([]);
    });
});
