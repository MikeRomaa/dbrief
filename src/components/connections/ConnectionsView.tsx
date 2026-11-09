import { open } from "@tauri-apps/plugin-dialog";
import {
    ChevronDown,
    ChevronsDownUp,
    ChevronsUpDown,
    Copy,
    FileUp,
    FolderPlus,
    Link,
    Pencil,
    Pin,
    PinOff,
    Plug,
    Plus,
    Search,
    Trash2,
    Unplug,
    X,
} from "lucide-react";
import { useMemo, useState } from "react";

import { ConnectionFormDialog, type FormStart } from "@/components/connections/ConnectionFormDialog";
import { ConnectionInspector, EmptyInspector, FolderInspector } from "@/components/connections/ConnectionInspector";
import { ConnectionTable } from "@/components/connections/ConnectionTable";
import { FolderNameDialog } from "@/components/connections/FolderNameDialog";
import { PinnedCards } from "@/components/connections/PinnedCards";
import { RemoveDialog } from "@/components/connections/RemoveDialog";
import { EngineIcon } from "@/components/ui/EngineIcon";
import { MenuButton, type MenuEntry } from "@/components/ui/Menu";
import { useConnectFlow } from "@/hooks/useConnectFlow";
import type { ConnectionsState } from "@/hooks/useConnections";
import { activeConnection } from "@/lib/connections/activeConnection";
import {
    allFolderIds,
    type Connection,
    type ItemRef,
    type Move,
    type Row,
    SORT_LABELS,
    type SortOrder,
    visibleRows,
} from "@/lib/connections/connectionTree";
import { confirmDisconnect } from "@/lib/connections/disconnect";
import { engines } from "@/lib/engine";
import { backend, type Credentials } from "@/lib/ipc/backend";

import styles from "@/components/connections/ConnectionsView.module.css";
import controls from "@/components/ui/controls.module.css";

type DialogState =
    | { kind: "form"; connection: Connection | null; start: FormStart }
    | { kind: "new-folder"; parentId: string | null }
    | { kind: "rename-folder"; id: string; name: string }
    | { kind: "remove"; item: ItemRef; name: string };

export function ConnectionsView({ state }: { state: ConnectionsState }) {
    const { tree, index, sessions, home, collapsed, sort, run } = state;
    const [filter, setFilter] = useState("");
    const [selected, setSelected] = useState<ItemRef | null>(null);
    const [dialog, setDialog] = useState<DialogState | null>(null);
    const [connecting, setConnecting] = useState<string | null>(null);

    const rows = useMemo(() => visibleRows(tree, { collapsed, filter, sort }), [tree, collapsed, filter, sort]);
    const connected = useMemo(
        () => new Set(sessions.filter((s) => s.background).map((s) => s.connection_id)),
        [sessions],
    );
    const canReorder = sort === "manual" && filter.trim() === "";
    const hasAnything = index.connections.size > 0 || index.folders.size > 0;
    const allCollapsed = index.folders.size > 0 && allFolderIds(index).every((id) => collapsed.has(id));

    const selectedConnection = selected?.kind === "connection" ? index.connections.get(selected.id) : undefined;
    const selectedFolder = selected?.kind === "folder" ? index.folders.get(selected.id) : undefined;

    const toggleFolder = (id: string, expanded: boolean) => {
        const next = new Set(collapsed);
        if (expanded) next.delete(id);
        else next.add(id);
        state.setCollapsed(next);
    };

    const connectFlow = useConnectFlow(state.persistentSecrets, state.report);
    const connect = async (connection: Connection, prompted: Credentials = {}) => {
        setConnecting(connection.id);
        try {
            // The most recently connected connection becomes the active one (status bar, Explorer).
            if (await connectFlow.connect(connection, prompted, "background")) activeConnection.set(connection.id);
        } finally {
            setConnecting(null);
            await state.reload();
        }
    };

    const disconnect = (connectionId: string) =>
        run(async () => {
            // Tabs with an open transaction on this connection ask to commit or roll back first.
            if (!(await confirmDisconnect(connectionId))) return;
            await backend.disconnectConnection(connectionId);
        });

    const duplicate = (id: string) =>
        run(async () => {
            const saved = await backend.duplicateConnection(id);
            setSelected({ kind: "connection", id: saved.connection.id });
            if (saved.warning) state.report(saved.warning);
        });

    const move = (m: Move) => run(() => backend.moveItem(m.item, m.parentId, m.before));
    const setPinned = (id: string, pinned: boolean) => run(() => backend.setPinned(id, pinned));
    const update = (c: Connection) => run(() => backend.updateConnection(c.id, c));

    const askRemove = (item: ItemRef) => {
        const name = item.kind === "folder" ? index.folders.get(item.id)?.name : index.connections.get(item.id)?.name;
        if (name !== undefined) setDialog({ kind: "remove", item, name });
    };

    const askRename = (id: string) => {
        const folder = index.folders.get(id);
        if (folder) setDialog({ kind: "rename-folder", id, name: folder.name });
    };

    const openSqliteFile = async () => {
        const path = await open({
            title: "Open SQLite file",
            filters: [{ name: "SQLite database", extensions: [...engines.sqlite.fileExtensions] }],
        });
        if (typeof path !== "string") return;

        const opened = await run(() => backend.openSqliteFile(path));
        if (opened) setSelected({ kind: "connection", id: opened.connection.id });
    };

    const activate = (row: Row) => {
        if (row.kind === "folder") toggleFolder(row.id, !row.expanded);
        else if (!connected.has(row.id)) void connect(row.connection);
    };

    const rowMenu = (row: Row): MenuEntry[] => {
        if (row.kind === "folder") {
            return [
                {
                    label: "New folder inside",
                    icon: <FolderPlus size={14} />,
                    onSelect: () => setDialog({ kind: "new-folder", parentId: row.id }),
                },
                { label: "Rename", icon: <Pencil size={14} />, onSelect: () => askRename(row.id) },
                "separator",
                { label: "Delete folder", icon: <Trash2 size={14} />, danger: true, onSelect: () => askRemove(row) },
            ];
        }

        const c = row.connection;
        return [
            connected.has(c.id)
                ? { label: "Disconnect", icon: <Unplug size={14} />, onSelect: () => void disconnect(c.id) }
                : { label: "Connect", icon: <Plug size={14} />, onSelect: () => void connect(c) },
            { label: "Edit", icon: <Pencil size={14} />, onSelect: () => edit(c) },
            { label: "Duplicate", icon: <Copy size={14} />, onSelect: () => void duplicate(c.id) },
            c.pinned
                ? { label: "Unpin", icon: <PinOff size={14} />, onSelect: () => void setPinned(c.id, false) }
                : { label: "Pin", icon: <Pin size={14} />, onSelect: () => void setPinned(c.id, true) },
            "separator",
            {
                label: "Remove connection",
                icon: <Trash2 size={14} />,
                danger: true,
                onSelect: () => askRemove({ kind: "connection", id: c.id }),
            },
        ];
    };

    /** New connections go in the selected folder, or next to the selected connection. */
    const newConnection = (start: Partial<FormStart> = {}) =>
        setDialog({
            kind: "form",
            connection: null,
            start: {
                engine: "postgres",
                folderId: selectedFolder?.id ?? selectedConnection?.folder_id ?? null,
                ...start,
            },
        });

    const edit = (c: Connection) =>
        setDialog({ kind: "form", connection: c, start: { engine: c.engine, folderId: c.folder_id } });

    const newMenu: MenuEntry[] = [
        {
            label: "PostgreSQL",
            icon: <EngineIcon engine="postgres" size={15} />,
            onSelect: () => newConnection({ engine: "postgres" }),
        },
        {
            label: "SQLite",
            icon: <EngineIcon engine="sqlite" size={15} />,
            hint: "file",
            onSelect: () => void openSqliteFile(),
        },
        "separator",
        { label: "From connection URL", icon: <Link size={14} />, onSelect: () => newConnection({ urlMode: true }) },
        { label: "Import from file", icon: <FileUp size={14} />, disabled: true, onSelect: () => {} },
    ];

    const sortMenu: MenuEntry[] = (Object.keys(SORT_LABELS) as SortOrder[]).map((s) => ({
        label: SORT_LABELS[s],
        hint: s === sort ? "✓" : undefined,
        onSelect: () => state.setSort(s),
    }));

    return (
        <div className={styles.view}>
            <div className={styles.main}>
                <header className={styles.header}>
                    <h1 className={styles.title}>Connections</h1>
                    <span className={styles.titleCount}>{index.connections.size}</span>
                    <span className={styles.spacer} />
                    <label className={styles.filter}>
                        <Search size={13} aria-hidden />
                        <input
                            type="search"
                            value={filter}
                            onChange={(e) => setFilter(e.target.value)}
                            onKeyDown={(e) => {
                                if (e.key === "Escape" && filter) {
                                    e.stopPropagation();
                                    setFilter("");
                                }
                            }}
                            placeholder="Filter by name or host"
                            aria-label="Filter by name or host"
                            spellCheck={false}
                            autoComplete="off"
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
                        className={controls.button}
                        onClick={() =>
                            setDialog({ kind: "new-folder", parentId: selectedFolder ? selectedFolder.id : null })
                        }
                    >
                        <FolderPlus size={13} />
                        New folder
                    </button>
                    <span className={styles.split}>
                        <button type="button" className={controls.primary} onClick={() => newConnection()}>
                            <Plus size={12} />
                            New connection
                        </button>
                        <MenuButton
                            label="More ways to add a connection"
                            entries={newMenu}
                            align="end"
                            className={`${controls.primary} ${styles.splitChevron}`}
                        >
                            <ChevronDown size={14} strokeWidth={2} />
                        </MenuButton>
                    </span>
                </header>

                {state.error && (
                    <div className={styles.banner} role="alert">
                        <span className={styles.bannerText}>{state.error}</span>
                        <button
                            type="button"
                            className={controls.iconButton}
                            aria-label="Dismiss"
                            onClick={state.dismissError}
                        >
                            <X size={12} />
                        </button>
                    </div>
                )}

                <div className={styles.body} data-scroll>
                    {!hasAnything ? (
                        <div className={styles.empty}>
                            <p className={styles.emptyTitle}>No connections yet</p>
                            <p className={styles.emptyText}>
                                Add a PostgreSQL server or open a SQLite file. Folders keep them organized.
                            </p>
                            <div className={styles.inspectorButtons}>
                                <button type="button" className={controls.primary} onClick={() => newConnection()}>
                                    <Plus size={12} />
                                    New connection
                                </button>
                                <button type="button" className={controls.button} onClick={() => void openSqliteFile()}>
                                    <EngineIcon engine="sqlite" size={13} />
                                    Open SQLite file
                                </button>
                                <button
                                    type="button"
                                    className={controls.button}
                                    onClick={() => setDialog({ kind: "new-folder", parentId: null })}
                                >
                                    <FolderPlus size={13} />
                                    New folder
                                </button>
                            </div>
                        </div>
                    ) : (
                        <>
                            {tree.pinned.length > 0 && !filter && (
                                <PinnedCards
                                    pinned={tree.pinned}
                                    index={index}
                                    selected={selected}
                                    connected={connected}
                                    home={home}
                                    onSelect={setSelected}
                                    onConnect={(c) => void connect(c)}
                                    onUnpin={(id) => void setPinned(id, false)}
                                />
                            )}
                            <section className={`${styles.section} ${styles.grow}`} aria-labelledby="all-label">
                                <div className={styles.sectionHeader}>
                                    <h2 id="all-label" className={controls.sectionLabel}>
                                        All connections
                                    </h2>
                                    <span className={styles.spacer} />
                                    <MenuButton
                                        label="Sort order"
                                        entries={sortMenu}
                                        align="end"
                                        className={controls.ghost}
                                    >
                                        {SORT_LABELS[sort]}
                                        <ChevronDown size={12} />
                                    </MenuButton>
                                    <button
                                        type="button"
                                        className={controls.ghost}
                                        disabled={index.folders.size === 0}
                                        onClick={() =>
                                            state.setCollapsed(allCollapsed ? new Set() : new Set(allFolderIds(index)))
                                        }
                                    >
                                        {allCollapsed ? <ChevronsUpDown size={13} /> : <ChevronsDownUp size={13} />}
                                        {allCollapsed ? "Expand all" : "Collapse all"}
                                    </button>
                                </div>
                                {rows.length === 0 ? (
                                    <p className={styles.noMatches}>No connections match “{filter.trim()}”.</p>
                                ) : (
                                    <ConnectionTable
                                        tree={tree}
                                        index={index}
                                        rows={rows}
                                        selected={selected}
                                        connected={connected}
                                        home={home}
                                        canReorder={canReorder}
                                        onSelect={setSelected}
                                        onToggle={toggleFolder}
                                        onActivate={activate}
                                        onMove={(m) => void move(m)}
                                        onPin={(id, pinned) => void setPinned(id, pinned)}
                                        onRemove={askRemove}
                                        onRename={askRename}
                                        rowMenu={rowMenu}
                                    />
                                )}
                            </section>
                        </>
                    )}
                </div>
            </div>

            {selectedConnection ? (
                <ConnectionInspector
                    connection={selectedConnection}
                    index={index}
                    connected={connected.has(selectedConnection.id)}
                    connecting={connecting === selectedConnection.id}
                    home={home}
                    onConnect={() => void connect(selectedConnection)}
                    onDisconnect={() => void disconnect(selectedConnection.id)}
                    onEdit={() => edit(selectedConnection)}
                    onDuplicate={() => void duplicate(selectedConnection.id)}
                    onChange={(c) => void update(c)}
                    onRemove={() => askRemove({ kind: "connection", id: selectedConnection.id })}
                />
            ) : selectedFolder ? (
                <FolderInspector
                    folder={selectedFolder}
                    index={index}
                    onNewFolder={() => setDialog({ kind: "new-folder", parentId: selectedFolder.id })}
                    onRename={() => askRename(selectedFolder.id)}
                    onDelete={() => askRemove({ kind: "folder", id: selectedFolder.id })}
                />
            ) : (
                <EmptyInspector />
            )}

            {dialog?.kind === "new-folder" && (
                <FolderNameDialog
                    title="New folder"
                    action="Create"
                    onClose={() => setDialog(null)}
                    onSave={async (name) => {
                        const folder = await run(() => backend.createFolder(name, dialog.parentId));
                        if (folder) {
                            setSelected({ kind: "folder", id: folder.id });
                            if (dialog.parentId) toggleFolder(dialog.parentId, true);
                        }
                    }}
                />
            )}
            {dialog?.kind === "rename-folder" && (
                <FolderNameDialog
                    title="Rename folder"
                    action="Rename"
                    initial={dialog.name}
                    onClose={() => setDialog(null)}
                    onSave={async (name) => {
                        await run(() => backend.renameFolder(dialog.id, name));
                    }}
                />
            )}
            {dialog?.kind === "remove" && (
                <RemoveDialog
                    item={dialog.item}
                    name={dialog.name}
                    onClose={() => setDialog(null)}
                    onConfirm={async () => {
                        const removed = await run(() => backend.removeItem(dialog.item));
                        if (removed) {
                            setSelected(null);
                            if (removed.secret_errors.length > 0) {
                                state.report(
                                    `Some saved passwords could not be deleted: ${removed.secret_errors.join("; ")}`,
                                );
                            }
                        }
                    }}
                />
            )}
            {dialog?.kind === "form" && (
                <ConnectionFormDialog
                    connection={dialog.connection}
                    start={dialog.start}
                    tree={tree}
                    persistentSecrets={state.persistentSecrets}
                    onClose={() => setDialog(null)}
                    onSaved={(saved, connectWith, warning) => {
                        setDialog(null);
                        setSelected({ kind: "connection", id: saved.id });
                        if (warning) state.report(warning);
                        if (connectWith) void connect(saved, connectWith);
                        else void state.reload();
                    }}
                />
            )}
            {connectFlow.prompt}
        </div>
    );
}
