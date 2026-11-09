import { describe, expect, it } from "vitest";

import {
    displayDate,
    formatDate,
    formatDateTime,
    monthGrid,
    parseDate,
    parseDateTime,
    validOffset,
    validTime,
} from "@/lib/grid/dates";
import { booleanText, editorKind, hasTimeZone, isTrue, looksLikeJson, validate } from "@/lib/grid/editors";
import { parsePgArray, serializePgArray } from "@/lib/grid/pgArray";
import { parseTsv, planPaste } from "@/lib/grid/tsv";

describe("editorKind", () => {
    it("reads PostgreSQL types", () => {
        expect(editorKind("integer", "postgres")).toBe("integer");
        expect(editorKind("numeric(10,2)", "postgres")).toBe("number");
        expect(editorKind("double precision", "postgres")).toBe("number");
        expect(editorKind("boolean", "postgres")).toBe("boolean");
        expect(editorKind("date", "postgres")).toBe("date");
        expect(editorKind("timestamp(3) with time zone", "postgres")).toBe("datetime");
        expect(editorKind("jsonb", "postgres")).toBe("json");
        expect(editorKind("integer[]", "postgres")).toBe("array");
        expect(editorKind("bytea", "postgres")).toBe("binary");
        expect(editorKind("character varying(20)", "postgres")).toBe("text");
        expect(editorKind("mood", "postgres")).toBe("text");
        expect(hasTimeZone("timestamp with time zone")).toBe(true);
        expect(hasTimeZone("timestamp without time zone")).toBe(false);
    });

    it("reads SQLite declared types", () => {
        expect(editorKind("INTEGER", "sqlite")).toBe("number");
        expect(editorKind("BOOLEAN", "sqlite")).toBe("boolean");
        expect(editorKind("DATETIME", "sqlite")).toBe("datetime");
        expect(editorKind("DATE", "sqlite")).toBe("date");
        expect(editorKind("REAL", "sqlite")).toBe("number");
        expect(editorKind("BLOB", "sqlite")).toBe("binary");
        expect(editorKind("", "sqlite")).toBe("text");
        expect(editorKind("VARCHAR(10)", "sqlite")).toBe("text");
    });
});

describe("validate", () => {
    it("checks numbers and integer ranges", () => {
        expect(validate("integer", "42", "integer", "postgres")).toBeNull();
        expect(validate("integer", "2147483648", "integer", "postgres")).toMatch(/range/);
        expect(validate("integer", "-32768", "smallint", "postgres")).toBeNull();
        expect(validate("integer", "-32769", "smallint", "postgres")).toMatch(/range/);
        expect(validate("integer", "1.5", "integer", "postgres")).toMatch(/whole/);
        expect(validate("number", "-1.5e3", "numeric", "postgres")).toBeNull();
        expect(validate("number", "NaN", "numeric", "postgres")).toBeNull();
        expect(validate("number", "NaN", "REAL", "sqlite")).toMatch(/number/);
        expect(validate("number", "1,5", "numeric", "postgres")).toMatch(/number/);
    });

    it("checks booleans, dates and JSON", () => {
        expect(validate("boolean", "TRUE", "boolean", "postgres")).toBeNull();
        expect(validate("boolean", "maybe", "boolean", "postgres")).not.toBeNull();
        expect(validate("date", "2024-02-30", "date", "postgres")).not.toBeNull();
        expect(validate("date", "infinity", "date", "postgres")).toBeNull();
        expect(validate("date", "last week", "DATE", "sqlite")).toBeNull();
        expect(validate("json", '{"a":1}', "jsonb", "postgres")).toBeNull();
        expect(validate("json", "{a:1}", "jsonb", "postgres")).toMatch(/Invalid JSON/);
        expect(validate("array", "{1,2}", "integer[]", "postgres")).toBeNull();
        expect(validate("array", "[1,2]", "integer[]", "postgres")).not.toBeNull();
        expect(validate("text", "", "text", "postgres")).toBeNull();
        expect(booleanText(true, "sqlite")).toBe("1");
        expect(booleanText(false, "postgres")).toBe("false");
        expect(isTrue("t")).toBe(true);
        expect(isTrue("0")).toBe(false);
    });
});

describe("looksLikeJson", () => {
    it("finds objects and arrays in text, not scalars or near misses", () => {
        expect(looksLikeJson('{"tier":1,"seats":10}')).toBe(true);
        expect(looksLikeJson('  [1, "a", null]\n')).toBe(true);
        expect(looksLikeJson("{}")).toBe(true);
        expect(looksLikeJson("42")).toBe(false);
        expect(looksLikeJson("true")).toBe(false);
        expect(looksLikeJson('"quoted"')).toBe(false);
        expect(looksLikeJson("{not json}")).toBe(false);
        expect(looksLikeJson("[1, 2")).toBe(false);
        expect(looksLikeJson("{a} and more")).toBe(false);
        expect(looksLikeJson("")).toBe(false);
    });
});

describe("dates", () => {
    it("parses and writes PostgreSQL ISO output", () => {
        expect(parseDate("2024-05-02")).toEqual({ year: 2024, month: 5, day: 2, bc: false });
        expect(parseDate("0044-03-15 BC")).toEqual({ year: 44, month: 3, day: 15, bc: true });
        expect(parseDate("2023-02-29")).toBeNull();
        const dt = parseDateTime("2024-05-02 09:14:22.5+05:30");
        expect(dt).toEqual({ year: 2024, month: 5, day: 2, bc: false, time: "09:14:22.5", offset: "+05:30" });
        expect(dt && formatDateTime(dt)).toBe("2024-05-02 09:14:22.5+05:30");
        expect(parseDateTime("2024-05-02T09:14Z")?.offset).toBe("Z");
        expect(parseDateTime("2024-05-02T09:14Z")?.time).toBe("09:14:00");
        expect(parseDateTime("2024-05-02 25:00:00")).toBeNull();
        expect(formatDate({ year: 7, month: 1, day: 9, bc: false })).toBe("0007-01-09");
        expect(validTime("09:05")).toBe(true);
        expect(validTime("09:05:01.123456")).toBe(true);
        expect(validTime("9:05")).toBe(false);
        expect(validOffset("+01")).toBe(true);
        expect(validOffset("-0530")).toBe(true);
        expect(validOffset("1")).toBe(false);
    });

    it("displays in ISO or the system format without shifting the time", () => {
        expect(displayDate("2024-05-02 09:14:22+01", "datetime", "iso")).toBe("2024-05-02 09:14:22+01");
        const local = displayDate("2024-05-02 09:14:22+01", "datetime", "locale");
        expect(local).toContain("09:14:22");
        expect(local).toContain("+01");
        expect(local).toContain("2024");
        expect(displayDate("infinity", "date", "locale")).toBe("infinity");
    });

    it("lays out a month from Monday", () => {
        const sept = monthGrid(2023, 9);
        expect(sept[0]).toEqual({ year: 2023, month: 8, day: 28 });
        expect(sept.length % 7).toBe(0);
        expect(sept.filter((d) => d.month === 9)).toHaveLength(30);
    });
});

describe("arrays", () => {
    it("round-trips through serializePgArray", () => {
        const items = ["a", "b c", null, "NULL", "", 'say "hi"', "back\\slash", "{x}", "a,b"];
        const text = serializePgArray(items);
        expect(text).toBe('{a,"b c",NULL,"NULL","","say \\"hi\\"","back\\\\slash","{x}","a,b"}');
        expect(parsePgArray(text)).toEqual(items);
        expect(serializePgArray([["1", "2"], ["3"]])).toBe("{{1,2},{3}}");
        expect(serializePgArray([])).toBe("{}");
    });
});

describe("TSV", () => {
    it("reads spreadsheet quoting", () => {
        expect(parseTsv("a\tb\nc\td\n")).toEqual([
            ["a", "b"],
            ["c", "d"],
        ]);
        expect(parseTsv('"x\ty"\t"line\nbreak"\r\n"say ""hi"""\t')).toEqual([
            ["x\ty", "line\nbreak"],
            ['say "hi"', ""],
        ]);
        expect(parseTsv("single")).toEqual([["single"]]);
        expect(parseTsv("")).toEqual([]);
        // What the grid's own TSV copy writes reads back the same.
        expect(parseTsv("note\tid\nHello there\t1\n\t2")).toEqual([
            ["note", "id"],
            ["Hello there", "1"],
            ["", "2"],
        ]);
    });

    it("plans where a paste lands", () => {
        expect(planPaste([["v"]], { top: 1, bottom: 2, left: 0, right: 1 }, 2)).toEqual([
            { row: 1, col: 0, text: "v" },
            { row: 1, col: 1, text: "v" },
            { row: 2, col: 0, text: "v" },
            { row: 2, col: 1, text: "v" },
        ]);
        expect(
            planPaste(
                [
                    ["a", "b", "c"],
                    ["d", "e", "f"],
                ],
                { top: 4, bottom: 4, left: 1, right: 1 },
                3,
            ),
        ).toEqual([
            { row: 4, col: 1, text: "a" },
            { row: 4, col: 2, text: "b" },
            { row: 5, col: 1, text: "d" },
            { row: 5, col: 2, text: "e" },
        ]);
    });
});
