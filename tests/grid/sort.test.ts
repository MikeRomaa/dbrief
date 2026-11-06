import { describe, expect, it } from "vitest";

import { cycleSort, sortBy, sortOf } from "@/grid/sort";

describe("header sorting", () => {
    it("cycles ascending, descending, none", () => {
        const one = cycleSort("", "name", false);
        expect(one).toBe('"name" ASC');
        const two = cycleSort(one, "name", false);
        expect(two).toBe('"name" DESC');
        expect(cycleSort(two, "name", false)).toBe("");
    });

    it("adds secondary sorts with Shift", () => {
        const first = cycleSort("", "a", false);
        const both = cycleSort(first, "b", true);
        expect(both).toBe('"a" ASC, "b" ASC');
        expect(sortOf(both, "b")).toEqual({ direction: "asc", position: 2 });
        expect(cycleSort(both, "a", true)).toBe('"a" DESC, "b" ASC');
        expect(cycleSort(cycleSort(both, "a", true), "a", true)).toBe('"b" ASC');
    });

    it("replaces text it doesn't understand", () => {
        expect(sortOf("lower(name)", "name")).toBeNull();
        expect(cycleSort("lower(name)", "name", true)).toBe('"name" ASC');
    });

    it("quotes odd names", () => {
        const order = sortBy('say "hi", ok', "desc");
        expect(order).toBe('"say ""hi"", ok" DESC');
        expect(sortOf(order, 'say "hi", ok')).toEqual({ direction: "desc", position: 1 });
    });
});
