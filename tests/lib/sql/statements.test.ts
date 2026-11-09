import { describe, expect, it } from "vitest";

import {
    fillPlaceholders,
    findPlaceholders,
    placeholderKeys,
    splitStatements,
    statementAt,
    statementsIn,
} from "@/lib/sql/statements";

const texts = (sql: string, dialect: "postgres" | "sqlite" = "postgres") =>
    splitStatements(sql, dialect).map((s) => s.text);

describe("splitStatements", () => {
    it("splits on semicolons and trims", () => {
        expect(texts("select 1;\n  select 2 ;select 3")).toEqual(["select 1", "select 2", "select 3"]);
        expect(texts("  ;; \n")).toEqual([]);
    });

    it("keeps leading comments with their statement and drops comment-only stretches", () => {
        expect(texts("-- revenue\nselect 1;\n-- trailing note\n/* block */\n")).toEqual(["-- revenue\nselect 1"]);
    });

    it("ignores semicolons in strings, identifiers and comments", () => {
        expect(texts("select ';', 'it''s;'; select \"a;b\" from t; -- x;y\nselect 3")).toEqual([
            "select ';', 'it''s;'",
            'select "a;b" from t',
            "-- x;y\nselect 3",
        ]);
        expect(texts("select /* a; /* nested; */ still; */ 1; select 2")).toEqual([
            "select /* a; /* nested; */ still; */ 1",
            "select 2",
        ]);
    });

    it("handles PostgreSQL escape strings and dollar quotes", () => {
        expect(texts("select E'a\\';b'; select 2")).toEqual(["select E'a\\';b'", "select 2"]);
        const fn = "create function f() returns int as $body$ begin; return 1; end; $body$ language plpgsql";
        expect(texts(`${fn}; select $$;$$; select $1`)).toEqual([fn, "select $$;$$", "select $1"]);
        // An unterminated dollar body runs to the end.
        expect(texts("select $x$ ; ;")).toEqual(["select $x$ ; ;"]);
    });

    it("follows SQLite's rules", () => {
        // No backslash escapes and no nested comments in SQLite.
        expect(texts("select 'a\\'; select 2", "sqlite")).toEqual(["select 'a\\'", "select 2"]);
        expect(texts("select /* a /* b */ 1; select [x;y], `p;q`", "sqlite")).toEqual([
            "select /* a /* b */ 1",
            "select [x;y], `p;q`",
        ]);
    });

    it("reports ranges", () => {
        const sql = "  select 1;\nselect 2";
        const [first, second] = splitStatements(sql, "postgres");
        expect(first).toEqual({ from: 2, to: 10, end: 11, text: "select 1" });
        expect(second).toMatchObject({ from: 12, to: 20, end: 20 });
    });
});

describe("statementAt", () => {
    const sql = "select 1;\n\nselect 2;\nselect 3";
    const statements = splitStatements(sql, "postgres");

    it("picks the statement under or just before the cursor", () => {
        expect(statementAt(statements, 3)?.text).toBe("select 1");
        expect(statementAt(statements, sql.indexOf(";") + 1)?.text).toBe("select 1");
        expect(statementAt(statements, 10)?.text).toBe("select 1");
        expect(statementAt(statements, sql.length)?.text).toBe("select 3");
    });

    it("falls forward when nothing is before the cursor", () => {
        const leading = splitStatements("\n\nselect 1", "postgres");
        expect(statementAt(leading, 0)?.text).toBe("select 1");
        expect(statementAt([], 0)).toBeUndefined();
    });

    it("lists the statements a selection touches", () => {
        expect(statementsIn(statements, 5, 14).map((s) => s.text)).toEqual(["select 1", "select 2"]);
    });
});

describe("placeholders", () => {
    it("finds the three styles outside strings and comments", () => {
        const sql = "select ?1, :name, %(other)s, ':skip', \"x?1\" -- :also_skip\nfrom t where a::int = :name";
        expect(findPlaceholders(sql, "postgres").map((p) => p.key)).toEqual(["1", "name", "other", "name"]);
    });

    it("ignores casts and dollar bodies", () => {
        expect(findPlaceholders("select x::text, $$ :inside $$", "postgres")).toEqual([]);
    });

    it("lists each key once, in order of appearance", () => {
        expect(placeholderKeys("select :b, ?1, :b, %(c)s", "postgres")).toEqual(["b", "1", "c"]);
    });

    it("fills placeholders with quoted literals", () => {
        expect(
            fillPlaceholders("select :a, ?1, :a where x = %(n)s", "postgres", { a: "it's", "1": "42", n: null }),
        ).toBe("select 'it''s', '42', 'it''s' where x = NULL");
        expect(fillPlaceholders("select :a, :b", "sqlite", { a: "x" })).toBe("select 'x', :b");
        expect(fillPlaceholders("select ':a'", "postgres", { a: "x" })).toBe("select ':a'");
    });
});
