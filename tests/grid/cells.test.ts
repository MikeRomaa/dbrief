import { describe, expect, it } from "vitest";

import { cellText } from "@/grid/cells";

const options = { nullDisplay: "null" as const, jsonTruncation: 5 };

describe("cellText", () => {
    it("shows NULL in the chosen style", () => {
        expect(cellText(null, "TEXT", options)).toEqual({ text: "NULL", kind: "null" });
        expect(cellText(null, "TEXT", { ...options, nullDisplay: "symbol" }).text).toBe("∅");
        expect(cellText(null, "TEXT", { ...options, nullDisplay: "blank" }).text).toBe("");
    });

    it("cuts JSON at the setting and long text where the backend cut it", () => {
        expect(cellText('{"a":1,"b":2}', "JSONB", options).text).toBe('{"a":…');
        expect(cellText('{"a":1,"b":2}', "TEXT", options).text).toBe('{"a":1,"b":2}');
        expect(cellText({ cut: "abc", length: 5000 }, "TEXT", options).text).toBe("abc…");
    });

    it("describes binary values by size", () => {
        expect(cellText({ binary: 14_000, image: null }, "BYTEA", options)).toEqual({
            text: "<binary 14 kB>",
            kind: "binary",
        });
        expect(cellText({ binary: 900, image: "png" }, "BLOB", options).text).toBe("<PNG image 900 B>");
    });
});
