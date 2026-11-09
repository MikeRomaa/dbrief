import type {
    Connection_Serialize,
    ConnectionTree_Serialize,
    FolderNode_Serialize,
    ItemRef,
    TreeNode_Serialize,
} from "@/lib/ipc/bindings";

export type Connection = Connection_Serialize;
export type ConnectionTree = ConnectionTree_Serialize;
export type FolderNode = FolderNode_Serialize;
export type TreeNode = TreeNode_Serialize;
export type { ItemRef };

export type SortOrder = "manual" | "name" | "last-used";

export const SORT_LABELS: Record<SortOrder, string> = {
    manual: "Manual order",
    name: "Name",
    "last-used": "Last used",
};

/** One visible line of the connections table. */
export type Row =
    | { kind: "folder"; id: string; depth: number; parentId: string | null; folder: FolderNode; expanded: boolean }
    | { kind: "connection"; id: string; depth: number; parentId: string | null; connection: Connection };

export interface RowOptions {
    collapsed: ReadonlySet<string>;
    filter: string;
    sort: SortOrder;
}

export const refOf = (row: Row | TreeNode): ItemRef =>
    row.kind === "folder" ? { kind: "folder", id: row.id } : { kind: "connection", id: row.id };

const nameOf = (node: TreeNode) => node.name.toLowerCase();

function sortNodes(nodes: TreeNode[], sort: SortOrder): TreeNode[] {
    if (sort === "manual") {
        return nodes;
    }

    // Folders first, by name; then connections by name or by most recently used.
    const folders = nodes.filter((n) => n.kind === "folder").sort((a, b) => nameOf(a).localeCompare(nameOf(b)));
    const connections = nodes.filter((n) => n.kind === "connection");
    connections.sort((a, b) => {
        if (sort === "last-used" && a.kind === "connection" && b.kind === "connection") {
            const byUse = (b.last_used_at ?? "").localeCompare(a.last_used_at ?? "");
            if (byUse !== 0) {
                return byUse;
            }
        }

        return nameOf(a).localeCompare(nameOf(b));
    });

    return [...folders, ...connections];
}

/** Host or file path, as matched by the filter and shown in the Host column. */
export function connectionLocation(connection: Connection): string {
    return (connection.engine === "sqlite" ? connection.file_path : connection.host) ?? "";
}

function matches(connection: Connection, filter: string): boolean {
    return (
        connection.name.toLowerCase().includes(filter) || connectionLocation(connection).toLowerCase().includes(filter)
    );
}

/** Whether a folder has a connection matching `filter` anywhere inside it. */
function containsMatch(folder: FolderNode, filter: string): boolean {
    return folder.children.some((child) =>
        child.kind === "folder" ? containsMatch(child, filter) : matches(child, filter),
    );
}

/**
 * The rows to show, in order. A filter matches connection names and hosts; it shows the matching
 * connections with their folders, all expanded.
 */
export function visibleRows(tree: ConnectionTree, { collapsed, filter, sort }: RowOptions): Row[] {
    const needle = filter.trim().toLowerCase();
    const rows: Row[] = [];

    const walk = (nodes: TreeNode[], depth: number, parentId: string | null) => {
        for (const node of sortNodes(nodes, sort)) {
            if (node.kind === "folder") {
                if (needle && !containsMatch(node, needle)) {
                    continue;
                }

                const expanded = needle !== "" || !collapsed.has(node.id);
                rows.push({ kind: "folder", id: node.id, depth, parentId, folder: node, expanded });

                if (expanded) {
                    walk(node.children, depth + 1, node.id);
                }
            } else if (!needle || matches(node, needle)) {
                rows.push({ kind: "connection", id: node.id, depth, parentId, connection: node });
            }
        }
    };

    walk(tree.root, 0, null);
    return rows;
}

/** Lookups by id. `parents` maps every folder and connection to its parent folder (`null` = root). */
export interface TreeIndex {
    folders: Map<string, FolderNode>;
    connections: Map<string, Connection>;
    parents: Map<string, string | null>;
}

export function indexTree(tree: ConnectionTree): TreeIndex {
    const index: TreeIndex = { folders: new Map(), connections: new Map(), parents: new Map() };

    const walk = (nodes: TreeNode[], parentId: string | null) => {
        for (const node of nodes) {
            index.parents.set(node.id, parentId);

            if (node.kind === "folder") {
                index.folders.set(node.id, node);
                walk(node.children, node.id);
            } else {
                index.connections.set(node.id, node);
            }
        }
    };

    walk(tree.root, null);
    return index;
}

/** Folder names from the root down to `folderId`, e.g. ["Billing", "Production"]. */
export function folderPath(index: TreeIndex, folderId: string | null): string[] {
    const names: string[] = [];
    let id = folderId;

    while (id) {
        const folder = index.folders.get(id);
        if (!folder) break;

        names.unshift(folder.name);
        id = folder.parent_id;
    }

    return names;
}

/** Every folder id, for "Collapse all". */
export function allFolderIds(index: TreeIndex): string[] {
    return [...index.folders.keys()];
}

/** Whether `folderId` is `ancestorId` or inside it. */
function isWithin(index: TreeIndex, folderId: string | null, ancestorId: string): boolean {
    let id = folderId;

    while (id) {
        if (id === ancestorId) return true;
        id = index.parents.get(id) ?? null;
    }

    return false;
}

export type DropPosition = "before" | "after" | "inside";

/**
 * Where a pointer at `offset` px from the top of a `height` px row drops. Folders take the middle
 * half as "inside"; connections split in two.
 */
export function dropPosition(row: Row, offset: number, height: number): DropPosition {
    const ratio = offset / height;

    if (row.kind === "folder") {
        if (ratio < 0.25) return "before";
        if (ratio > 0.75) return "after";
        return "inside";
    }

    return ratio < 0.5 ? "before" : "after";
}

/** A move for `move_item`, and the text shown while dragging. */
export interface Move {
    item: ItemRef;
    parentId: string | null;
    before: ItemRef | null;
    label: string;
}

/**
 * The move for dropping `item` at `position` relative to `rows[targetIndex]`, or `null` when the drop
 * isn't allowed (onto itself, or a folder into itself or its own subfolder).
 */
export function dropMove(
    rows: Row[],
    index: TreeIndex,
    item: ItemRef,
    targetIndex: number,
    position: DropPosition,
): Move | null {
    const target = rows[targetIndex];
    if (!target || target.id === item.id) {
        return null;
    }

    const name = target.kind === "folder" ? target.folder.name : target.connection.name;
    let move: Move;

    if (position === "inside") {
        if (target.kind !== "folder") return null;
        move = { item, parentId: target.id, before: null, label: `Move into ${name}` };
    } else if (position === "before") {
        move = { item, parentId: target.parentId, before: refOf(target), label: `Move above ${name}` };
    } else if (target.kind === "folder" && target.expanded && rows[targetIndex + 1]?.parentId === target.id) {
        // Just below an open folder is its first child's place.
        const first = rows[targetIndex + 1];
        move = { item, parentId: target.id, before: first ? refOf(first) : null, label: `Move into ${name}` };
    } else {
        let next: Row | undefined;
        for (let i = targetIndex + 1; i < rows.length; i++) {
            const row = rows[i];
            if (!row || row.depth < target.depth) break;
            if (row.depth === target.depth) {
                next = row;
                break;
            }
        }

        move = { item, parentId: target.parentId, before: next ? refOf(next) : null, label: `Move below ${name}` };
    }

    if (move.before?.id === item.id) {
        return null;
    }

    if (item.kind === "folder" && isWithin(index, move.parentId, item.id)) {
        return null;
    }

    return move;
}

/** Siblings of `item` in manual order. */
function siblingsOf(tree: ConnectionTree, index: TreeIndex, item: ItemRef): TreeNode[] {
    const parentId = index.parents.get(item.id) ?? null;
    return parentId ? (index.folders.get(parentId)?.children ?? []) : tree.root;
}

/** Moves `item` one place up or down among its siblings (keyboard reordering), or `null` at the edge. */
export function siblingMove(tree: ConnectionTree, index: TreeIndex, item: ItemRef, direction: -1 | 1): Move | null {
    const siblings = siblingsOf(tree, index, item);
    const at = siblings.findIndex((s) => s.id === item.id);
    if (at < 0) {
        return null;
    }

    const parentId = index.parents.get(item.id) ?? null;

    if (direction === -1) {
        const previous = siblings[at - 1];
        return previous ? { item, parentId, before: refOf(previous), label: `Move above ${previous.name}` } : null;
    }

    const next = siblings[at + 1];
    if (!next) {
        return null;
    }

    const after = siblings[at + 2];
    return { item, parentId, before: after ? refOf(after) : null, label: `Move below ${next.name}` };
}

export interface Counts {
    connections: number;
    folders: number;
}

export function countTree(index: TreeIndex): Counts {
    return { connections: index.connections.size, folders: index.folders.size };
}
