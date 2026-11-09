import { describe, expect, it } from "vitest";

import {
    buildForest,
    buildRows,
    defaultExpanded,
    type ExplorerConnection,
    groupId,
    objectId,
    parentIndex,
    schemaId,
} from "@/lib/explorer/tree";
import type { SchemaColumn, SchemaObject } from "@/lib/ipc/bindings";

const obj = (schema: string, name: string, kind: SchemaObject["kind"]): SchemaObject => ({
    schema,
    name,
    kind,
    parent: null,
    detail: null,
    estimated_rows: null,
    size_bytes: null,
});

const pg = [
    obj("public", "public", "schema"),
    obj("billing", "billing", "schema"),
    obj("empty", "empty", "schema"),
    obj("public", "users", "table"),
    obj("public", "orders", "table"),
    obj("public", "active_users", "view"),
    obj("billing", "invoices", "table"),
];

const labels = (rows: ReturnType<typeof buildRows>) =>
    rows.map((r) =>
        r.type === "schema"
            ? `S ${r.schema}`
            : r.type === "group"
              ? `G ${r.kind} (${r.count})`
              : r.type === "object"
                ? `O ${r.object.name}`
                : r.type === "column"
                  ? `C ${r.column.name}`
                  : `N ${r.text}`,
    );

describe("explorer tree", () => {
    it("opens PostgreSQL's public tables by default", () => {
        const rows = buildRows(pg, "postgres", defaultExpanded("postgres"), new Map(), "");
        expect(labels(rows)).toEqual([
            "S billing",
            "S empty",
            "S public",
            "G table (2)",
            "O users",
            "O orders",
            "G view (1)",
        ]);
    });

    it("shows columns of expanded tables, or that they are loading", () => {
        const users = pg[3] as SchemaObject;
        const expanded = new Set([schemaId("public"), groupId("public", "table"), objectId(users)]);
        const loading = buildRows(pg, "postgres", expanded, new Map(), "");
        expect(labels(loading)).toContain("N Loading…");

        const column = { name: "id" } as SchemaColumn;
        const loaded = buildRows(pg, "postgres", expanded, new Map([[objectId(users), [column]]]), "");
        expect(labels(loaded)).toContain("C id");
    });

    it("filters objects and opens their parents", () => {
        const rows = buildRows(pg, "postgres", new Set(), new Map(), "INV");
        expect(labels(rows)).toEqual(["S billing", "G table (1)", "O invoices"]);
    });

    it("puts SQLite's main groups at the top and attached databases after", () => {
        const lite = [obj("main", "t", "table"), obj("main", "t_idx", "index"), obj("archive", "old", "table")];
        const rows = buildRows(lite, "sqlite", defaultExpanded("sqlite"), new Map(), "");
        expect(labels(rows)).toEqual(["G table (1)", "O t", "G index (1)", "S archive"]);
        expect(parentIndex(rows, 1)).toBe(0);
        expect(parentIndex(rows, 0)).toBe(-1);
    });

    describe("forest", () => {
        const conn = (id: string, status: string | null = null): ExplorerConnection => ({
            id,
            name: id,
            engine: "postgres",
            status,
            objects: pg,
            expanded: new Set([schemaId("billing")]),
            columns: new Map(),
        });

        it("puts each connection's tree one level under it, with unique keys", () => {
            const rows = buildForest([conn("a", "Loading the schema…"), conn("b")], new Set(["b"]), "");
            expect(rows.map((r) => `${r.level} ${r.key}`)).toEqual([
                "1 a",
                "2 a:status",
                "2 a/s:billing",
                "3 a/g:billing:table",
                "2 a/s:empty",
                "2 a/s:public",
                "1 b",
            ]);
            expect(rows.every((r) => r.connectionId === r.key.split(/[/:]/)[0])).toBe(true);
        });

        it("filters across connections and leaves out those without a match", () => {
            const other = { ...conn("b"), objects: [obj("public", "public", "schema"), obj("public", "x", "table")] };
            const rows = buildForest([conn("a"), other], new Set(["a"]), "invoice");
            expect(rows.map((r) => r.key)).toEqual([
                "a",
                "a/s:billing",
                "a/g:billing:table",
                "a/o:billing:table:invoices:",
            ]);
        });
    });
});
