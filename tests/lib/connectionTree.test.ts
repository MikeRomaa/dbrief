import { describe, expect, it } from "vitest";

import {
    type Connection,
    type ConnectionTree,
    countTree,
    dropMove,
    dropPosition,
    type FolderNode,
    folderPath,
    indexTree,
    type Row,
    siblingMove,
    type TreeNode,
    visibleRows,
} from "@/lib/connectionTree";

function connection(id: string, extra: Partial<Connection> = {}): TreeNode {
    return {
        kind: "connection",
        id,
        name: id,
        folder_id: null,
        engine: "postgres",
        access_level: "rw",
        color_tag: null,
        host: `${id}.internal`,
        port: null,
        database: null,
        username: null,
        ssl_mode: null,
        ca_cert_path: null,
        file_path: null,
        ssh: null,
        connect_timeout_s: null,
        query_timeout_s: null,
        default_schema: null,
        startup_sql: null,
        confirm_before_commit: false,
        manual_transactions: true,
        pinned: false,
        sort_order: 0,
        created_at: "2026-01-01T00:00:00Z",
        last_used_at: null,
        server_version: null,
        ...extra,
    };
}

function folder(id: string, children: TreeNode[], parentId: string | null = null): TreeNode {
    const node: FolderNode & { kind: "folder" } = {
        kind: "folder",
        id,
        name: id,
        parent_id: parentId,
        sort_order: 0,
        connection_count: 0,
        children,
    };
    return node;
}

// billing/            (folder)
//   prod/             (folder)
//     billing_ro
//   billing_rw
// app.db
const tree: ConnectionTree = {
    pinned: [],
    root: [
        folder("billing", [
            folder("prod", [connection("billing_ro", { last_used_at: "2026-01-02T00:00:00Z" })], "billing"),
            connection("billing_rw", { last_used_at: "2026-01-03T00:00:00Z" }),
        ]),
        connection("app.db", { engine: "sqlite", host: null, file_path: "/home/me/app.db" }),
    ],
};

const ids = (rows: Row[]) => rows.map((r) => `${"  ".repeat(r.depth)}${r.id}`);

const all = { collapsed: new Set<string>(), filter: "", sort: "manual" as const };

describe("visibleRows", () => {
    it("flattens the tree in manual order with depths", () => {
        expect(ids(visibleRows(tree, all))).toEqual(["billing", "  prod", "    billing_ro", "  billing_rw", "app.db"]);
    });

    it("hides the contents of collapsed folders", () => {
        const rows = visibleRows(tree, { ...all, collapsed: new Set(["prod"]) });
        expect(ids(rows)).toEqual(["billing", "  prod", "  billing_rw", "app.db"]);
        expect(rows[1]).toMatchObject({ kind: "folder", expanded: false });
    });

    it("filters by name or host and opens the folders on the way", () => {
        const collapsed = new Set(["billing", "prod"]);
        expect(ids(visibleRows(tree, { ...all, collapsed, filter: "RO" }))).toEqual([
            "billing",
            "  prod",
            "    billing_ro",
        ]);
        expect(ids(visibleRows(tree, { ...all, filter: "home/me" }))).toEqual(["app.db"]);
        expect(visibleRows(tree, { ...all, filter: "nothing" })).toEqual([]);
    });

    it("sorts folders first, then by name or last use", () => {
        expect(ids(visibleRows(tree, { ...all, sort: "name" }))).toEqual([
            "billing",
            "  prod",
            "    billing_ro",
            "  billing_rw",
            "app.db",
        ]);

        const flat: ConnectionTree = { pinned: [], root: (tree.root[0] as FolderNode).children };
        expect(ids(visibleRows(flat, { ...all, sort: "last-used", collapsed: new Set(["prod"]) }))).toEqual([
            "prod",
            "billing_rw",
        ]);
    });
});

describe("tree index", () => {
    const index = indexTree(tree);

    it("knows folder paths and counts", () => {
        expect(folderPath(index, "prod")).toEqual(["billing", "prod"]);
        expect(folderPath(index, null)).toEqual([]);
        expect(countTree(index)).toEqual({ connections: 3, folders: 2 });
    });
});

describe("drag and drop", () => {
    const index = indexTree(tree);
    const rows = visibleRows(tree, all);
    const at = (id: string) => rows.findIndex((r) => r.id === id);
    const appDb = { kind: "connection", id: "app.db" } as const;

    it("splits rows into drop zones", () => {
        const folderRow = rows[at("prod")] as Row;
        const connectionRow = rows[at("billing_rw")] as Row;
        expect(dropPosition(folderRow, 2, 28)).toBe("before");
        expect(dropPosition(folderRow, 14, 28)).toBe("inside");
        expect(dropPosition(folderRow, 26, 28)).toBe("after");
        expect(dropPosition(connectionRow, 13, 28)).toBe("before");
        expect(dropPosition(connectionRow, 15, 28)).toBe("after");
    });

    it("moves above, below and into", () => {
        expect(dropMove(rows, index, appDb, at("billing_rw"), "before")).toEqual({
            item: appDb,
            parentId: "billing",
            before: { kind: "connection", id: "billing_rw" },
            label: "Move above billing_rw",
        });
        // Below the last child: the end of its folder.
        expect(dropMove(rows, index, appDb, at("billing_rw"), "after")).toMatchObject({
            parentId: "billing",
            before: null,
        });
        // Below a nested row: before the next row at the same depth.
        expect(dropMove(rows, index, appDb, at("billing_ro"), "after")).toMatchObject({
            parentId: "prod",
            before: null,
        });
        expect(dropMove(rows, index, appDb, at("prod"), "inside")).toMatchObject({
            parentId: "prod",
            before: null,
            label: "Move into prod",
        });
        // Just below an open folder is its first place.
        expect(dropMove(rows, index, appDb, at("prod"), "after")).toMatchObject({
            parentId: "prod",
            before: { kind: "connection", id: "billing_ro" },
        });
    });

    it("refuses drops onto itself or into its own subfolders", () => {
        const billing = { kind: "folder", id: "billing" } as const;
        expect(dropMove(rows, index, billing, at("billing"), "inside")).toBeNull();
        expect(dropMove(rows, index, billing, at("prod"), "inside")).toBeNull();
        expect(dropMove(rows, index, billing, at("billing_ro"), "before")).toBeNull();
        expect(dropMove(rows, index, billing, at("app.db"), "before")).toMatchObject({ parentId: null });
        expect(dropMove(rows, index, appDb, at("billing_rw"), "inside")).toBeNull();
    });

    it("moves among siblings with the keyboard", () => {
        const rw = { kind: "connection", id: "billing_rw" } as const;
        expect(siblingMove(tree, index, rw, -1)).toMatchObject({
            parentId: "billing",
            before: { kind: "folder", id: "prod" },
        });
        expect(siblingMove(tree, index, rw, 1)).toBeNull();
        expect(siblingMove(tree, index, { kind: "folder", id: "billing" }, 1)).toMatchObject({
            parentId: null,
            before: null,
            label: "Move below app.db",
        });
    });
});
