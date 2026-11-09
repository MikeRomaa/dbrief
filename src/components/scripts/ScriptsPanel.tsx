import {
    ChevronDown,
    ChevronRight,
    FileCode,
    FilePlus,
    Folder,
    FolderOpen,
    FolderPlus,
    NotebookPen,
    Pencil,
    Search,
    Trash2,
    X,
} from "lucide-react";
import { type KeyboardEvent, type PointerEvent, useMemo, useRef, useState } from "react";

import { FolderNameDialog } from "@/components/connections/FolderNameDialog";
import { Dialog } from "@/components/ui/Dialog";
import { MenuButton, type MenuEntry } from "@/components/ui/Menu";
import { backend, errorMessage } from "@/lib/ipc/backend";
import type { ScriptNode } from "@/lib/ipc/bindings";
import { SCRATCHPAD } from "@/lib/scripts/scratchpad";
import { tooltip } from "@/lib/shell/tooltip";

import styles from "@/components/scripts/ScriptsPanel.module.css";
import controls from "@/components/ui/controls.module.css";

/**
 * The Scripts side panel: the scripts folder as a tree. Single click opens a preview tab, double
 * click or Enter pins it. Rows drag onto folders to move them.
 */
interface ScriptsPanelProps {
    tree: ScriptNode[];
    error: string | null;
    activePath: string | null;
    onOpen: (path: string, preview: boolean) => void;
    onRenamed: (from: string, to: string) => void;
    onRemoved: (path: string) => void;
    reload: () => Promise<void>;
}

interface Row {
    node: ScriptNode;
    depth: number;
    expanded: boolean;
}

type DialogState =
    | { kind: "new-folder"; dir: string }
    | { kind: "rename"; node: ScriptNode }
    | { kind: "delete"; node: ScriptNode };

const INDENT = 14;
const DRAG_THRESHOLD = 4;

const parentOf = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");
const join = (dir: string, name: string) => (dir ? `${dir}/${name}` : name);

/** Rows to show; a filter keeps matching scripts and opens the folders on the way. */
function visibleRows(nodes: ScriptNode[], collapsed: ReadonlySet<string>, filter: string, depth = 0): Row[] {
    const needle = filter.trim().toLowerCase();
    return nodes.flatMap((node) => {
        if (node.kind === "script") {
            return !needle || node.name.toLowerCase().includes(needle) ? [{ node, depth, expanded: false }] : [];
        }

        const children = visibleRows(node.children, collapsed, filter, depth + 1);
        if (needle && children.length === 0) return [];

        const expanded = needle !== "" || !collapsed.has(node.path);
        return [{ node, depth, expanded }, ...(expanded ? children : [])];
    });
}

export function ScriptsPanel({ tree, error, activePath, onOpen, onRenamed, onRemoved, reload }: ScriptsPanelProps) {
    const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
    const [filter, setFilter] = useState("");
    // A clicked row stays highlighted only until the open tab changes; the highlight then follows the
    // open tab again (switching to the Scratchpad, or from the tab strip).
    const [clicked, setClicked] = useState<string | null>(null);
    const [clickedUnder, setClickedUnder] = useState(activePath);
    if (clickedUnder !== activePath) {
        setClickedUnder(activePath);
        setClicked(null);
    }
    const [dialog, setDialog] = useState<DialogState | null>(null);
    const [problem, setProblem] = useState<string | null>(null);
    const [drag, setDrag] = useState<{ path: string; target: string | null; x: number; y: number } | null>(null);
    const pending = useRef<{ path: string; x: number; y: number; id: number } | null>(null);
    const listRef = useRef<HTMLDivElement>(null);

    const rows = useMemo(() => visibleRows(tree, collapsed, filter), [tree, collapsed, filter]);
    const current = clicked ?? activePath;
    const setSelected = setClicked;

    const act = async (action: () => Promise<unknown>) => {
        try {
            await action();
            setProblem(null);
        } catch (e) {
            setProblem(errorMessage(e));
        }
        await reload();
    };

    const toggle = (path: string, open?: boolean) => {
        const next = new Set(collapsed);
        if (open ?? next.has(path)) next.delete(path);
        else next.add(path);
        setCollapsed(next);
    };

    const newScript = (dir: string) =>
        act(async () => {
            const path = await backend.createScript(dir);
            if (dir) toggle(dir, true);
            onOpen(path, false);
        });

    const move = (from: string, toDir: string) => {
        const name = from.slice(from.lastIndexOf("/") + 1);
        const to = join(toDir, name);
        if (to === from || parentOf(from) === toDir) return;
        void act(async () => {
            await backend.renameScript(from, to);
            onRenamed(from, to);
        });
    };

    const dirOf = (node: ScriptNode | undefined) =>
        !node ? "" : node.kind === "folder" ? node.path : parentOf(node.path);
    const selectedNode = rows.find((r) => r.node.path === current)?.node;

    const menu = (node: ScriptNode): MenuEntry[] => [
        ...(node.kind === "script"
            ? [{ label: "Open", icon: <FileCode size={14} />, onSelect: () => onOpen(node.path, false) }]
            : []),
        { label: "New script here", icon: <FilePlus size={14} />, onSelect: () => void newScript(dirOf(node)) },
        {
            label: "New folder here",
            icon: <FolderPlus size={14} />,
            onSelect: () => setDialog({ kind: "new-folder", dir: dirOf(node) }),
        },
        "separator",
        { label: "Rename", icon: <Pencil size={14} />, onSelect: () => setDialog({ kind: "rename", node }) },
        {
            label: "Move to Trash",
            icon: <Trash2 size={14} />,
            danger: true,
            onSelect: () => setDialog({ kind: "delete", node }),
        },
    ];

    const focusRow = (index: number) => {
        const row = rows[index];
        if (!row) return;
        setSelected(row.node.path);
        listRef.current?.querySelector<HTMLElement>(`[data-index="${index}"]`)?.focus();
    };

    const onKeyDown = (index: number, e: KeyboardEvent<HTMLDivElement>) => {
        const row = rows[index];
        if (!row || e.target !== e.currentTarget) return;
        const { node } = row;
        const handled = () => e.preventDefault();

        switch (e.key) {
            case "ArrowDown":
                handled();
                return focusRow(Math.min(index + 1, rows.length - 1));
            case "ArrowUp":
                handled();
                return focusRow(Math.max(index - 1, 0));
            case "ArrowRight":
                handled();
                if (node.kind === "folder" && !row.expanded) toggle(node.path, true);
                else if (node.kind === "folder") focusRow(index + 1);
                return;
            case "ArrowLeft": {
                handled();
                if (node.kind === "folder" && row.expanded) return toggle(node.path, false);
                const parent = rows.findIndex((r) => r.node.path === parentOf(node.path));
                return focusRow(parent);
            }
            case "Enter":
                handled();
                if (node.kind === "script") onOpen(node.path, false);
                else toggle(node.path);
                return;
            case "F2":
                handled();
                return setDialog({ kind: "rename", node });
            case "Delete":
            case "Backspace":
                handled();
                return setDialog({ kind: "delete", node });
        }
    };

    const folderAt = (x: number, y: number): string | null => {
        const el = document.elementFromPoint(x, y);
        const row = el?.closest<HTMLElement>("[data-path]");
        if (row) {
            const path = row.dataset.path ?? "";
            return row.dataset.kind === "folder" ? path : parentOf(path);
        }
        // Empty space below the rows is the top of the folder.
        return listRef.current?.contains(el) ? "" : null;
    };

    const onPointerDown = (path: string, e: PointerEvent<HTMLDivElement>) => {
        if (e.button !== 0 || (e.target as HTMLElement).closest("button")) return;
        pending.current = { path, x: e.clientX, y: e.clientY, id: e.pointerId };
    };

    const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
        const p = pending.current;
        if (!p || p.id !== e.pointerId) return;
        if (!drag && Math.hypot(e.clientX - p.x, e.clientY - p.y) < DRAG_THRESHOLD) return;
        if (!drag) e.currentTarget.setPointerCapture(e.pointerId);

        const target = folderAt(e.clientX, e.clientY);
        // A folder can't move into itself.
        const allowed = target !== null && !(target === p.path || target.startsWith(`${p.path}/`));
        setDrag({ path: p.path, target: allowed ? target : null, x: e.clientX, y: e.clientY });
    };

    const onPointerUp = () => {
        const d = drag;
        pending.current = null;
        setDrag(null);
        if (d?.target !== null && d) move(d.path, d.target);
    };

    return (
        <div className={styles.panel}>
            <div className={styles.header}>
                <h2 className={controls.sectionLabel}>Scripts</h2>
                <span className={styles.spacer} />
                <button
                    type="button"
                    className={controls.iconButton}
                    aria-label="New script"
                    onClick={() => void newScript(dirOf(selectedNode))}
                    {...tooltip("New script")}
                >
                    <FilePlus size={14} />
                </button>
                <button
                    type="button"
                    className={controls.iconButton}
                    aria-label="New folder"
                    onClick={() => setDialog({ kind: "new-folder", dir: dirOf(selectedNode) })}
                    {...tooltip("New folder")}
                >
                    <FolderPlus size={14} />
                </button>
            </div>

            <label className={styles.filter}>
                <Search size={13} aria-hidden="true" />
                <input
                    type="search"
                    value={filter}
                    placeholder="Filter scripts"
                    aria-label="Filter scripts"
                    spellCheck={false}
                    onChange={(e) => setFilter(e.target.value)}
                    onKeyDown={(e) => {
                        if (e.key === "Escape" && filter) {
                            e.stopPropagation();
                            setFilter("");
                        }
                    }}
                />
                {filter && (
                    <button
                        type="button"
                        className={controls.iconButton}
                        aria-label="Clear filter"
                        onClick={() => setFilter("")}
                    >
                        <X size={12} />
                    </button>
                )}
            </label>

            <button
                type="button"
                className={styles.scratchpad}
                data-active={activePath === SCRATCHPAD || undefined}
                onClick={() => onOpen(SCRATCHPAD, false)}
                {...tooltip("SQL to try out, kept in DBrief instead of a file")}
            >
                <NotebookPen size={14} />
                Scratchpad
            </button>

            {(error ?? problem) && (
                <p className={styles.problem} role="alert">
                    {problem ?? error}
                </p>
            )}

            <div
                ref={listRef}
                role="tree"
                aria-label="Scripts"
                className={styles.tree}
                data-drop-root={drag?.target === "" || undefined}
            >
                {rows.map((row, i) => {
                    const { node } = row;
                    const isCurrent = node.path === current;
                    return (
                        <div
                            key={node.path}
                            role="treeitem"
                            aria-level={row.depth + 1}
                            aria-expanded={node.kind === "folder" ? row.expanded : undefined}
                            aria-selected={isCurrent}
                            tabIndex={isCurrent || (current === null && i === 0) ? 0 : -1}
                            data-index={i}
                            data-path={node.path}
                            data-kind={node.kind}
                            data-active={node.path === activePath || undefined}
                            data-drop={drag?.target === node.path || undefined}
                            data-dragging={drag?.path === node.path || undefined}
                            className={styles.row}
                            style={{ paddingLeft: 8 + row.depth * INDENT }}
                            onClick={() => {
                                setSelected(node.path);
                                if (node.kind === "script") onOpen(node.path, true);
                                else toggle(node.path);
                            }}
                            onDoubleClick={() => node.kind === "script" && onOpen(node.path, false)}
                            onKeyDown={(e) => onKeyDown(i, e)}
                            onContextMenu={(e) => {
                                e.preventDefault();
                                setSelected(node.path);
                                e.currentTarget.querySelector<HTMLButtonElement>("[data-row-menu]")?.click();
                            }}
                            onPointerDown={(e) => onPointerDown(node.path, e)}
                            onPointerMove={onPointerMove}
                            onPointerUp={onPointerUp}
                            onPointerCancel={onPointerUp}
                        >
                            {node.kind === "folder" ? (
                                <>
                                    <span className={styles.chevron} aria-hidden="true">
                                        {row.expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                                    </span>
                                    <span className={styles.icon} aria-hidden="true">
                                        {row.expanded ? <FolderOpen size={14} /> : <Folder size={14} />}
                                    </span>
                                </>
                            ) : (
                                <>
                                    <span className={styles.chevron} />
                                    <span className={styles.icon} aria-hidden="true">
                                        <FileCode size={14} />
                                    </span>
                                </>
                            )}
                            <span className={styles.name}>{node.name}</span>
                            {node.kind === "folder" && <span className={controls.count}>{countScripts(node)}</span>}
                            <MenuButton
                                label={`Actions for ${node.name}`}
                                entries={menu(node)}
                                align="end"
                                className={`${controls.iconButton} ${styles.rowMenu}`}
                                attrs={{ "data-row-menu": "" }}
                                tabIndex={-1}
                            >
                                <span aria-hidden="true">…</span>
                            </MenuButton>
                        </div>
                    );
                })}
                {rows.length === 0 && !error && (
                    <p className={styles.empty}>
                        {filter ? `No scripts match “${filter.trim()}”.` : "No scripts yet. Create one to get started."}
                    </p>
                )}
            </div>

            {drag && (
                <div className={styles.dragLabel} style={{ left: drag.x + 12, top: drag.y + 8 }} aria-hidden="true">
                    {drag.target === null
                        ? "Can't move here"
                        : `Move to ${drag.target === "" ? "the top" : drag.target}`}
                </div>
            )}

            {dialog?.kind === "new-folder" && (
                <FolderNameDialog
                    title="New folder"
                    action="Create"
                    onClose={() => setDialog(null)}
                    onSave={(name) =>
                        act(async () => {
                            await backend.createScriptFolder(dialog.dir, name);
                            if (dialog.dir) toggle(dialog.dir, true);
                        })
                    }
                />
            )}
            {dialog?.kind === "rename" && (
                <FolderNameDialog
                    title={dialog.node.kind === "folder" ? "Rename folder" : "Rename script"}
                    action="Rename"
                    initial={dialog.node.name}
                    onClose={() => setDialog(null)}
                    onSave={(name) => {
                        const node = dialog.node;
                        const fileName = node.kind === "script" && !/\.sql$/i.test(name) ? `${name}.sql` : name;
                        const to = join(parentOf(node.path), fileName);
                        if (to === node.path) return Promise.resolve();
                        return act(async () => {
                            await backend.renameScript(node.path, to);
                            onRenamed(node.path, to);
                        });
                    }}
                />
            )}
            {dialog?.kind === "delete" && (
                <Dialog
                    title={`Move “${dialog.node.name}” to the Trash?`}
                    onClose={() => setDialog(null)}
                    onSubmit={() => {
                        const node = dialog.node;
                        setDialog(null);
                        void act(async () => {
                            await backend.deleteScript(node.path);
                            onRemoved(node.path);
                        });
                    }}
                    footer={
                        <>
                            <button type="button" className={controls.button} onClick={() => setDialog(null)}>
                                Cancel
                            </button>
                            <button type="submit" className={controls.danger}>
                                Move to Trash
                            </button>
                        </>
                    }
                >
                    <p className={styles.dialogText}>
                        {dialog.node.kind === "folder"
                            ? `The folder and its ${countScripts(dialog.node)} scripts go to the Trash, where you can restore them.`
                            : "You can restore it from the Trash."}
                    </p>
                </Dialog>
            )}
        </div>
    );
}

function countScripts(node: ScriptNode): number {
    return node.kind === "script" ? 1 : node.children.reduce((n, c) => n + countScripts(c), 0);
}
