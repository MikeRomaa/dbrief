import { describe, expect, it } from "vitest";

import { isArrayType, parsePgArray } from "@/lib/grid/pgArray";

describe("parsePgArray", () => {
    it("reads plain, quoted, NULL and nested elements", () => {
        expect(parsePgArray("{1,2,3}")).toEqual(["1", "2", "3"]);
        expect(parsePgArray('{"a b",NULL,"say \\"hi\\"","NULL"}')).toEqual(["a b", null, 'say "hi"', "NULL"]);
        expect(parsePgArray("{{1,2},{3,4}}")).toEqual([
            ["1", "2"],
            ["3", "4"],
        ]);
        expect(parsePgArray("{}")).toEqual([]);
        expect(parsePgArray("[0:1]={a,b}")).toEqual(["a", "b"]);
    });

    it("rejects text that isn't an array", () => {
        expect(parsePgArray("hello")).toBeNull();
        expect(parsePgArray("{1,2")).toBeNull();
        expect(parsePgArray("{1}x")).toBeNull();
    });

    it("recognizes array types", () => {
        expect(isArrayType("INT4[]")).toBe(true);
        expect(isArrayType("_text")).toBe(true);
        expect(isArrayType("TEXT")).toBe(false);
    });
});
