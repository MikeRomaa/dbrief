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
import { useCallback, useMemo, useState } from "react";

import { ConnectionInspector, EmptyInspector, FolderInspector } from "@/connections/ConnectionInspector";
import { ConnectionTable } from "@/connections/ConnectionTable";
import { FolderNameDialog, RemoveDialog, SecretPrompt } from "@/connections/dialogs";
import { PinnedCards } from "@/connections/PinnedCards";
import type { ConnectionsState } from "@/connections/useConnections";
import { ActionFailure, backend, type Credentials } from "@/lib/backend";
import type { SecretKind } from "@/lib/bindings";
import {
    allFolderIds,
    type Connection,
    type ItemRef,
    type Move,
    type Row,
    SORT_LABELS,
    type SortOrder,
    visibleRows,
} from "@/lib/connectionTree";
import { EngineIcon } from "@/ui/EngineIcon";
import { MenuButton, type MenuEntry } from "@/ui/Menu";

import styles from "@/connections/ConnectionsView.module.css";
import controls from "@/ui/controls.module.css";

/** Extensions offered when picking a SQLite file; same list as `SQLITE_EXTENSIONS` in dbrief-core. */
const SQLITE_EXTENSIONS = ["db", "sqlite", "sqlite3", "db3", "s3db"];

const SECRET_FIELDS: Record<SecretKind, keyof Credentials> = {
    password: "password",
    "ssh-password": "ssh_password",
    "ssh-passphrase": "ssh_passphrase",
};

type DialogState =
    | { kind: "new-folder"; parentId: string | null }
    | { kind: "rename-folder"; id: string; name: string }
    | { kind: "remove"; item: ItemRef; name: string }
    | {
          kind: "secret";
          connection: Connection;
          secret: SecretKind;
          problem: string | null;
          prompted: Credentials;
      };

export function ConnectionsView({ state }: { state: ConnectionsState }) {
    const { tree, index, sessions, home, collapsed, sort, run } = state;
    const [filter, setFilter] = useState("");
    const [selected, setSelected] = useState<ItemRef | null>(null);
    const [dialog, setDialog] = useState<DialogState | null>(null);
    const [connecting, setConnecting] = useState<string | null>(null);

    const rows = useMemo(() => visibleRows(tree, { collapsed, filter, sort }), [tree, collapsed, filter, sort]);
    const connected = useMemo(() => new Set(sessions.map((s) => s.connection_id)), [sessions]);
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

    const connect = useCallback(
        async (connection: Connection, prompted: Credentials = {}, remember = false) => {
            setConnecting(connection.id);
            try {
                const result = await backend.connect(connection.id, prompted, remember);
                if (result.warning) state.report(result.warning);
                await state.reload();
            } catch (e) {
                if (e instanceof ActionFailure && e.error.kind === "secret-required") {
                    const { secret, message } = e.error;
                    // Only call it a failure when a secret was actually tried: typed, or stored.
                    const saved = await backend.savedSecrets(connection.id).catch(() => null);
                    const tried =
                        prompted[SECRET_FIELDS[secret]] != null ||
                        (secret === "password"
                            ? saved?.password
                            : secret === "ssh-password"
                              ? saved?.ssh_password
                              : saved?.ssh_passphrase);
                    setDialog({ kind: "secret", connection, secret, problem: tried ? message : null, prompted });
                } else {
                    state.report(e instanceof Error ? e.message : String(e));
                }
            } finally {
                setConnecting(null);
            }
        },
        [state],
    );

    const disconnect = (connectionId: string) =>
        run(async () => {
            for (const s of sessions.filter((s) => s.connection_id === connectionId)) {
                await backend.disconnect(s.id);
            }
        });

    const duplicate = (id: string) =>
        run(async () => {
            const saved = await backend.duplicateConnection(id);
            setSelected({ kind: "connection", id: saved.connection.id });
            if (saved.warning) state.report(saved.warning);
        });

    const move = (m: Move) => run(() => backend.moveItem(m.item, m.parentId, m.before));
    const setPinned = (id: string, pinned: boolean) => run(() => backend.setPinned(id, pinned));
    const update = (c: Connection) => run(() => backend.updateConnection(c));

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
            filters: [{ name: "SQLite database", extensions: SQLITE_EXTENSIONS }],
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

    const newMenu: MenuEntry[] = [
        { label: "PostgreSQL", icon: <EngineIcon engine="postgres" size={15} />, disabled: true, onSelect: () => {} },
        {
            label: "SQLite",
            icon: <EngineIcon engine="sqlite" size={15} />,
            hint: "file",
            onSelect: () => void openSqliteFile(),
        },
        "separator",
        { label: "From connection URL", icon: <Link size={14} />, disabled: true, onSelect: () => {} },
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
                    <MenuButton label="New connection" entries={newMenu} align="end" className={controls.primary}>
                        <Plus size={12} />
                        New connection
                        <ChevronDown size={12} />
                    </MenuButton>
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
                                Open a SQLite file, or create folders to organize the connections you add.
                            </p>
                            <div className={styles.inspectorButtons}>
                                <button
                                    type="button"
                                    className={controls.primary}
                                    onClick={() => void openSqliteFile()}
                                >
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
            {dialog?.kind === "secret" && (
                <SecretPrompt
                    connectionName={dialog.connection.name}
                    secret={dialog.secret}
                    problem={dialog.problem}
                    canRemember={state.persistentSecrets}
                    onClose={() => setDialog(null)}
                    onSubmit={(value, remember) => {
                        const prompted = { ...dialog.prompted, [SECRET_FIELDS[dialog.secret]]: value };
                        setDialog(null);
                        void connect(dialog.connection, prompted, remember);
                    }}
                />
            )}
        </div>
    );
}
