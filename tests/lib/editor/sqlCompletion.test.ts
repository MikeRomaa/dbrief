import { CompletionContext } from "@codemirror/autocomplete";
import { type SQLNamespace, sql } from "@codemirror/lang-sql";
import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";

import {
    columnsInScope,
    completionNamespace,
    completionOptionClass,
    keywordCompletion,
    sqlDialect,
    tablesInScope,
} from "@/lib/editor/sqlCompletion";
import type { SchemaObject } from "@/lib/ipc/bindings";

function object(kind: SchemaObject["kind"], name: string, extra: Partial<SchemaObject> = {}): SchemaObject {
    return {
        schema: "public",
        name,
        kind,
        parent: null,
        detail: null,
        estimated_rows: null,
        size_bytes: null,
        ...extra,
    };
}

interface Entry {
    self: Record<string, unknown>;
    children: unknown;
}

/** The namespace entry at `schema` → `name` (or the schema's own entry when `name` is omitted). */
function entry(ns: SQLNamespace, schema: string, name?: string): Entry {
    const level = (ns as unknown as Record<string, Entry | undefined>)[schema];
    if (!level) throw new Error(`no schema ${schema}`);
    if (name === undefined) return level;
    const found = (level.children as Record<string, Entry | undefined>)[name];
    if (!found) throw new Error(`no ${name} in ${schema}`);
    return found;
}

describe("completionNamespace", () => {
    it("lists each schema's objects with their kind and columns", () => {
        const ns = completionNamespace(
            [
                object("schema", "public"),
                object("schema", "empty"),
                object("table", "users"),
                object("index", "users_email_idx", { parent: "users" }),
                object("function", "touch", { detail: "(id integer) → void" }),
                object("materialized-view", "Totals"),
            ],
            [{ schema: "public", table: "users", columns: ["id", "email"] }],
            "postgres",
        );

        expect(Object.keys(ns).sort()).toEqual(["empty", "public"]);
        expect(entry(ns, "public").self).toEqual({ label: "public", type: "namespace", detail: "schema" });
        expect(entry(ns, "public", "users")).toEqual({
            self: { label: "users", type: "table", detail: "table" },
            children: ["id", "email"],
        });
        expect(entry(ns, "public", "users_email_idx").self).toEqual({
            label: "users_email_idx",
            type: "index",
            detail: "index on users",
        });
        expect(entry(ns, "public", "touch").self.detail).toBe("function (id integer) → void");
        expect(entry(ns, "public", "Totals").self).toMatchObject({ type: "view", apply: '"Totals"' });
    });

    it("keeps a table's columns when a function shares its name, and escapes dots", () => {
        const ns = completionNamespace(
            [object("table", "items"), object("function", "items"), object("table", "a.b")],
            [{ schema: "public", table: "items", columns: ["id"] }],
            "postgres",
        );
        expect(entry(ns, "public", "items")).toMatchObject({ self: { type: "table" }, children: ["id"] });
        expect(entry(ns, "public", "a\\.b").self.label).toBe("a.b");
    });

    it("adds tables that only the column list knows about", () => {
        const ns = completionNamespace([], [{ schema: "main", table: "Notes", columns: ["body"] }], "sqlite");
        // SQLite identifiers are case-insensitive, so mixed case needs no quotes.
        expect(entry(ns, "main", "Notes").self).toEqual({ label: "Notes", type: "table", detail: "table" });
    });
});

describe("keywords and functions", () => {
    it("types built-in functions apart from keywords", () => {
        const build = keywordCompletion("postgres");
        expect(build("COUNT", "keyword").type).toBe("function builtin");
        expect(build("SELECT", "keyword").type).toBe("keyword");
        expect(build("JSONB", "type").type).toBe("type");
    });

    it("adds functions to the dialect as built-ins without overriding keywords", () => {
        expect(sqlDialect("postgres").spec.builtin?.split(" ")).toContain("jsonb_build_object");
        expect(sqlDialect("postgres").spec.builtin?.split(" ")).not.toContain("count");
        expect(sqlDialect("sqlite").spec.builtin?.split(" ")).not.toContain("dump");
    });

    it("turns a completion's type into option classes", () => {
        expect(completionOptionClass({ label: "COUNT", type: "function builtin" })).toBe(
            "cm-completion-function cm-completion-builtin",
        );
        expect(completionOptionClass({ label: "x" })).toBe("");
    });
});

describe("columns in scope", () => {
    const ns = completionNamespace(
        [object("schema", "public"), object("table", "users"), object("table", "orders", { schema: "shop" })],
        [
            { schema: "public", table: "users", columns: ["id", "email", "Display Name"] },
            { schema: "shop", table: "orders", columns: ["id", "user_id", "total"] },
        ],
        "postgres",
    );

    function at(textWithCursor: string) {
        const pos = textWithCursor.indexOf("|");
        const doc = textWithCursor.replace("|", "");
        return { state: EditorState.create({ doc, extensions: sql({ dialect: sqlDialect("postgres") }) }), pos };
    }

    function complete(textWithCursor: string, explicit = false) {
        const { state, pos } = at(textWithCursor);
        const result = columnsInScope(ns, "public", "postgres")(new CompletionContext(state, pos, explicit));
        return result && !(result instanceof Promise) ? result.options.map((o) => `${o.label}:${o.detail}`) : null;
    }

    it("finds the tables after FROM, JOIN and in a FROM list", () => {
        const { state, pos } = at("SELECT | FROM users u JOIN shop.orders o ON o.user_id = u.id, Users AS x WHERE 1");
        expect(tablesInScope(state, pos)).toEqual([["users"], ["shop", "orders"], ["Users"]]);
    });

    it("looks inside a subquery and out to its statement", () => {
        const { state, pos } = at("SELECT * FROM users WHERE id IN (SELECT | FROM shop.orders)");
        expect(tablesInScope(state, pos)).toEqual([["shop", "orders"], ["users"]]);
    });

    it("offers those tables' columns unqualified", () => {
        expect(complete("SELECT i| FROM users JOIN shop.orders ON true")).toEqual([
            "id:users",
            "email:users",
            "Display Name:users",
            "id:orders",
            "user_id:orders",
            "total:orders",
        ]);
        expect(complete("UPDATE users SET em|")).toContain("email:users");
    });

    it("leaves qualified names, table positions and empty prefixes to the others", () => {
        expect(complete("SELECT u.| FROM users u", true)).toBeNull();
        expect(complete("SELECT * FROM us|")).toBeNull();
        expect(complete("SELECT | FROM users")).toBeNull();
        expect(complete("SELECT 'e|' FROM users")).toBeNull();
    });
});
