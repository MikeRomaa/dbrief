import {
    ChevronDown,
    ChevronRight,
    Database,
    Eye,
    Hash,
    KeyRound,
    Layers,
    ListTree,
    Plug,
    RefreshCw,
    Search,
    Sigma,
    Table2,
    Zap,
} from "lucide-react";
import { type KeyboardEvent, type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { EngineIcon } from "@/components/ui/EngineIcon";
import { ContextMenu, type MenuEntry } from "@/components/ui/Menu";
import { useCommands } from "@/hooks/useCommands";
import { useConnectFlow } from "@/hooks/useConnectFlow";
import type { ConnectionsState } from "@/hooks/useConnections";
import { useStore } from "@/hooks/useStore";
import { activeConnection } from "@/lib/connections/activeConnection";
import { colorTagVar } from "@/lib/connections/connectionFormat";
import { confirmDisconnect } from "@/lib/connections/disconnect";
import { revealConnection } from "@/lib/explorer/reveal";
import {
    buildForest,
    defaultExpanded,
    type ExplorerConnection,
    type ForestRow,
    GROUP_LABELS,
    objectId,
    parentIndex,
} from "@/lib/explorer/tree";
import { backend, errorMessage } from "@/lib/ipc/backend";
import type { ObjectKind, SchemaColumn, SchemaObject } from "@/lib/ipc/bindings";
import { ensureSchema, refreshSchema, schemaStore, tableColumns } from "@/lib/schema/schemaStore";
import { log } from "@/lib/shell/log";
import { RAIL_COMMANDS } from "@/lib/shell/shellCommands";
import { tooltip } from "@/lib/shell/tooltip";
import { displayName, type TableRef } from "@/lib/tabs/tableTabs";
import { compactCount, formatBytes, formatCount } from "@/lib/util/numbers";

import styles from "@/components/explorer/ExplorerPanel.module.css";
import panels from "@/components/shell/Panels.module.css";
import controls from "@/components/ui/controls.module.css";

/**
 * The Explorer side panel: every connected connection as a top-level node over its schema tree,
 * with a filter, row count estimates and sizes, and context menus. Disconnecting removes it.
 */
interface ExplorerPanelProps {
    connections: ConnectionsState;
    onOpenTable: (table: TableRef, preview: boolean, view?: "data" | "columns") => void;
}

const ROW_HEIGHT = 24;

const OBJECT_ICONS: Record<ObjectKind, ReactNode> = {
    schema: <Database size={13} />,
    table: <Table2 size={13} />,
    view: <Eye size={13} />,
    "materialized-view": <Layers size={13} />,
    function: <Sigma size={13} />,
    sequence: <Hash size={13} />,
    index: <ListTree size={13} />,
    trigger: <Zap size={13} />,
};

const opensAsTable = (kind: ObjectKind) => kind === "table" || kind === "view" || kind === "materialized-view";

/** Per-connection state that a schema reload (a new version) drops. */
type Versioned<T> = ReadonlyMap<string, { version: number; map: ReadonlyMap<string, T> }>;

const EMPTY = new Map<never, never>();

function versioned<T>(all: Versioned<T>, id: string, version: number): ReadonlyMap<string, T> {
    const entry = all.get(id);
    return entry && entry.version === version ? entry.map : EMPTY;
}

function withEntry<T>(all: Versioned<T>, id: string, version: number, key: string, value: T): Versioned<T> {
    const map = new Map(versioned(all, id, version)).set(key, value);
    return new Map(all).set(id, { version, map });
}

export function ExplorerPanel({ connections, onOpenTable }: ExplorerPanelProps) {
    const commands = useCommands();
    const activeId = useStore(activeConnection);
    const schemas = useStore(schemaStore);
    const reveal = useStore(revealConnection);

    const [filter, setFilter] = useState("");
    const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
    const [expandedBy, setExpandedBy] = useState<ReadonlyMap<string, ReadonlySet<string>>>(new Map());
    const [columns, setColumns] = useState<Versioned<SchemaColumn[]>>(new Map());
    const [counts, setCounts] = useState<Versioned<number>>(new Map());
    const [activeKey, setActiveKey] = useState<string | null>(null);
    const [menu, setMenu] = useState<{ x: number; y: number; row: ForestRow } | null>(null);
    const [problem, setProblem] = useState<string | null>(null);
    const [scroll, setScroll] = useState({ top: 0, height: 400 });
    const listRef = useRef<HTMLDivElement>(null);
    const connectFlow = useConnectFlow(connections.persistentSecrets, setProblem);

    const isConnected = (id: string) => connections.sessions.some((s) => s.background && s.connection_id === id);

    // Every connection with an open session.
    const listedIds = useMemo(() => {
        const ids = new Set(connections.sessions.filter((s) => s.background).map((s) => s.connection_id));
        return [...ids]
            .filter((id) => connections.index.connections.has(id))
            .sort((a, b) =>
                (connections.index.connections.get(a)?.name ?? "").localeCompare(
                    connections.index.connections.get(b)?.name ?? "",
                ),
            );
    }, [connections.sessions, connections.index]);

    useEffect(() => {
        for (const id of listedIds) ensureSchema(id);
    }, [listedIds]);

    const listed = useMemo<ExplorerConnection[]>(
        () =>
            listedIds.flatMap((id) => {
                const connection = connections.index.connections.get(id);
                if (!connection) return [];
                const schema = schemas.get(id);
                const version = schema?.version ?? 0;
                const status = schema?.error
                    ? schema.error
                    : schema?.loading || !schema?.refreshedAt
                      ? "Loading the schema…"
                      : null;
                return [
                    {
                        id,
                        name: connection.name,
                        engine: connection.engine,
                        status,
                        objects: schema?.objects ?? [],
                        expanded: expandedBy.get(id) ?? defaultExpanded(connection.engine),
                        columns: versioned(columns, id, version),
                    },
                ];
            }),
        [listedIds, connections.index, schemas, expandedBy, columns],
    );

    const rows = useMemo(() => buildForest(listed, collapsed, filter), [listed, collapsed, filter]);
    const active = Math.max(
        0,
        rows.findIndex((r) => r.key === activeKey),
    );
    const activeRow = rows[active];
    const setActive = (index: number) => setActiveKey(rows[Math.max(0, Math.min(rows.length - 1, index))]?.key ?? null);

    // Search asks to show a connection: open it and select it once it is listed.
    useEffect(() => {
        if (!reveal || !listedIds.includes(reveal)) return;
        setCollapsed((c) => {
            const next = new Set(c);
            next.delete(reveal);
            return next;
        });
        setActiveKey(reveal);
        revealConnection.set(null);
    }, [reveal, listedIds]);

    useLayoutEffect(() => {
        const el = listRef.current;
        if (!el) return;
        const update = () => setScroll({ top: el.scrollTop, height: el.clientHeight });
        update();
        const observer = new ResizeObserver(update);
        observer.observe(el);
        return () => observer.disconnect();
    }, []);

    // Keep the active row in view.
    useEffect(() => {
        const el = listRef.current;
        if (!el) return;
        const top = active * ROW_HEIGHT;
        if (top < el.scrollTop) el.scrollTop = top;
        else if (top + ROW_HEIGHT > el.scrollTop + el.clientHeight) el.scrollTop = top + ROW_HEIGHT - el.clientHeight;
    }, [active]);

    const connect = async (id: string) => {
        const connection = connections.index.connections.get(id);
        if (!connection) return false;
        if (isConnected(id)) return true;
        return (await connectFlow.connect(connection, {}, "background")) !== null;
    };

    const refresh = async (id: string) => {
        if (await connect(id)) await refreshSchema(id);
    };

    const disconnect = async (id: string) => {
        // Tabs with an open transaction on this connection ask to commit or roll back first.
        if (!(await confirmDisconnect(id))) return;
        try {
            await backend.disconnectConnection(id);
        } catch (e) {
            setProblem(errorMessage(e));
        }
    };

    const toggle = (row: ForestRow) => {
        if (row.type === "column" || row.type === "note") return;
        if (row.type === "connection") {
            setCollapsed((c) => {
                const next = new Set(c);
                if (row.expanded) next.add(row.id);
                else next.delete(row.id);
                return next;
            });
            return;
        }
        if (row.type === "object" && !row.expandable) return;
        const id = row.connectionId;
        const tree = listed.find((c) => c.id === id);
        if (!tree) return;
        const next = new Set(tree.expanded);
        if (next.has(row.id) || (row.type !== "object" && row.expanded)) {
            next.delete(row.id);
        } else {
            next.add(row.id);
            if (row.type === "object" && !tree.columns.has(row.id)) {
                const version = schemas.get(id)?.version ?? 0;
                const { schema: s, name } = row.object;
                void tableColumns(id, s, name).then((cols) =>
                    setColumns((m) => withEntry(m, id, version, row.id, cols)),
                );
            }
        }
        setExpandedBy((m) => new Map(m).set(id, next));
    };

    const tableRef = (connectionId: string, object: SchemaObject): TableRef | null =>
        opensAsTable(object.kind)
            ? { connectionId, schema: object.schema, name: object.name, kind: object.kind }
            : null;

    const open = (row: ForestRow, preview: boolean) => {
        if (row.type !== "object") return;
        const ref = tableRef(row.connectionId, row.object);
        if (ref) onOpenTable(ref, preview);
    };

    const sourceOf = (id: string) => connections.index.connections.get(id)?.name ?? "Explorer";

    const copyDdl = async (id: string, object: SchemaObject) => {
        if (!(await connect(id))) return;
        try {
            const ddl = await backend.objectDdl(id, {
                schema: object.schema,
                name: object.name,
                kind: object.kind,
                detail: object.detail,
            });
            await navigator.clipboard.writeText(ddl);
            log({
                kind: "background",
                source: sourceOf(id),
                text: `Copied the DDL of ${object.schema}.${object.name}`,
            });
        } catch (e) {
            setProblem(errorMessage(e));
        }
    };

    const countRows = async (id: string, object: SchemaObject) => {
        if (!(await connect(id))) return;
        try {
            const result = await backend.countRows(id, {
                schema: object.schema,
                name: object.name,
                filter: null,
                order: null,
            });
            const count = result.count ?? 0;
            const version = schemas.get(id)?.version ?? 0;
            setCounts((m) => withEntry(m, id, version, objectId(object), count));
            log({
                kind: "background",
                source: sourceOf(id),
                text: result.sql.replace(/\s+/g, " ").trim(),
                detail: `${formatCount(count)} rows, ${Math.round(result.duration_ms ?? 0)} ms`,
            });
        } catch (e) {
            setProblem(errorMessage(e));
        }
    };

    const menuEntries = (row: ForestRow): MenuEntry[] => {
        const id = row.connectionId;
        if (row.type === "connection") {
            return [
                { label: "Refresh the schema", onSelect: () => void refresh(id) },
                { label: "Disconnect", onSelect: () => void disconnect(id) },
            ];
        }
        if (row.type === "column") {
            return [
                {
                    label: "Copy name",
                    onSelect: () => void navigator.clipboard.writeText(row.column.name).catch(() => {}),
                },
            ];
        }
        if (row.type !== "object") return [];
        const object = row.object;
        const ref = tableRef(id, object);
        const entries: MenuEntry[] = [];
        if (ref) {
            entries.push(
                { label: "Open data", onSelect: () => onOpenTable(ref, false) },
                { label: "Open structure", onSelect: () => onOpenTable(ref, false, "columns") },
                "separator",
            );
        }
        entries.push(
            {
                label: "Copy name",
                onSelect: () => void navigator.clipboard.writeText(`${object.schema}.${object.name}`).catch(() => {}),
            },
            { label: "Copy DDL", onSelect: () => void copyDdl(id, object) },
        );
        if (ref) entries.push({ label: "Count rows", onSelect: () => void countRows(id, object) });
        return entries;
    };

    const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
        const row = activeRow;
        const move = (to: number) => {
            e.preventDefault();
            setActive(to);
        };
        switch (e.key) {
            case "ArrowDown":
                return move(active + 1);
            case "ArrowUp":
                return move(active - 1);
            case "Home":
                return move(0);
            case "End":
                return move(rows.length - 1);
            case "PageDown":
                return move(active + Math.floor(scroll.height / ROW_HEIGHT));
            case "PageUp":
                return move(active - Math.floor(scroll.height / ROW_HEIGHT));
            case "ArrowRight":
                e.preventDefault();
                if (row && "expanded" in row && !row.expanded) toggle(row);
                else if (row && "expanded" in row && row.expanded) setActive(active + 1);
                return;
            case "ArrowLeft":
                e.preventDefault();
                if (row && "expanded" in row && row.expanded) toggle(row);
                else setActive(parentIndex(rows, active));
                return;
            case "Enter":
                e.preventDefault();
                if (row?.type === "object" && opensAsTable(row.object.kind)) open(row, false);
                else if (row) toggle(row);
                return;
            case " ":
                e.preventDefault();
                if (row?.type === "object" && opensAsTable(row.object.kind)) open(row, true);
                return;
            case "ContextMenu":
                e.preventDefault();
                openMenuAtActive();
                return;
        }
        if (e.key === "F10" && e.shiftKey) {
            e.preventDefault();
            openMenuAtActive();
        }
    };

    const openMenuAtActive = () => {
        const row = activeRow;
        const el = row ? document.getElementById(rowId(row)) : null;
        const rect = el?.getBoundingClientRect();
        if (row) setMenu({ x: (rect?.left ?? 0) + 24, y: rect?.bottom ?? 0, row });
    };

    const rowId = (row: ForestRow) => `explorer-${row.key}`;

    const first = Math.max(0, Math.floor(scroll.top / ROW_HEIGHT) - 10);
    const last = Math.min(rows.length - 1, Math.ceil((scroll.top + scroll.height) / ROW_HEIGHT) + 10);

    // The header's Refresh acts on the selected row's connection.
    const refreshId = activeRow?.connectionId ?? (listedIds.length === 1 ? listedIds[0] : undefined);
    const refreshName = refreshId ? connections.index.connections.get(refreshId)?.name : undefined;

    return (
        <div className={styles.panel}>
            <div className={styles.header}>
                <h2 className={controls.sectionLabel}>Explorer</h2>
                <span className={styles.spacer} />
                <button
                    type="button"
                    className={controls.iconButton}
                    aria-label={refreshName ? `Refresh the schema of ${refreshName}` : "Refresh the schema"}
                    disabled={!refreshId || schemas.get(refreshId)?.loading}
                    onClick={() => refreshId && void refresh(refreshId)}
                    {...tooltip(refreshName ? `Refresh the schema of ${refreshName}` : "Refresh the schema")}
                >
                    <RefreshCw size={14} />
                </button>
            </div>
            <div className={styles.filter}>
                <Search size={12} aria-hidden />
                <input
                    className={styles.filterInput}
                    value={filter}
                    placeholder="Filter objects"
                    aria-label="Filter objects"
                    spellCheck={false}
                    onChange={(e) => {
                        setFilter(e.target.value);
                        setActiveKey(null);
                    }}
                    onKeyDown={(e) => {
                        if (e.key === "Escape" && filter) {
                            e.preventDefault();
                            setFilter("");
                        } else if (e.key === "ArrowDown") {
                            e.preventDefault();
                            listRef.current?.focus();
                        }
                    }}
                />
            </div>

            {problem && (
                <p className={controls.error} role="alert">
                    {problem}
                </p>
            )}

            {listed.length === 0 ? (
                <div className={styles.empty}>
                    <p>Open connections and their schemas appear here.</p>
                    <button
                        type="button"
                        className={controls.ghost}
                        onClick={() => commands.run(RAIL_COMMANDS.connections.id)}
                    >
                        <Plug size={12} />
                        Open Connections
                    </button>
                </div>
            ) : (
                <div
                    ref={listRef}
                    className={styles.tree}
                    role="tree"
                    aria-label="Open connections"
                    aria-activedescendant={activeRow ? rowId(activeRow) : undefined}
                    tabIndex={0}
                    onKeyDown={onKeyDown}
                    onScroll={(e) => {
                        const el = e.currentTarget;
                        setScroll({ top: el.scrollTop, height: el.clientHeight });
                    }}
                >
                    <div style={{ height: rows.length * ROW_HEIGHT, position: "relative" }}>
                        {rows.slice(first, last + 1).map((row, k) => {
                            const index = first + k;
                            const connection =
                                row.type === "connection" ? connections.index.connections.get(row.id) : undefined;
                            return (
                                <TreeRow
                                    key={row.key}
                                    id={rowId(row)}
                                    row={row}
                                    top={index * ROW_HEIGHT}
                                    active={index === active}
                                    current={row.type === "connection" && row.id === activeId}
                                    colorTag={connection?.color_tag ?? null}
                                    count={
                                        row.type === "object"
                                            ? versioned(
                                                  counts,
                                                  row.connectionId,
                                                  schemas.get(row.connectionId)?.version ?? 0,
                                              ).get(row.id)
                                            : undefined
                                    }
                                    onClick={(e) => {
                                        setActive(index);
                                        if (row.type === "object" && opensAsTable(row.object.kind)) {
                                            if (e.detail === 2) open(row, false);
                                            else open(row, true);
                                        } else {
                                            toggle(row);
                                        }
                                    }}
                                    onToggle={() => {
                                        setActive(index);
                                        toggle(row);
                                    }}
                                    onContextMenu={(e) => {
                                        e.preventDefault();
                                        setActive(index);
                                        if (menuEntries(row).length) setMenu({ x: e.clientX, y: e.clientY, row });
                                    }}
                                />
                            );
                        })}
                    </div>
                    {rows.length === 0 && filter && <p className={panels.placeholder}>No objects match.</p>}
                </div>
            )}

            {menu && (
                <ContextMenu
                    label={menu.row.type === "connection" ? "Connection" : "Object"}
                    at={menu}
                    entries={menuEntries(menu.row)}
                    onClose={() => setMenu(null)}
                    returnFocus={listRef.current}
                />
            )}
            {connectFlow.prompt}
        </div>
    );
}

interface TreeRowProps {
    id: string;
    row: ForestRow;
    top: number;
    active: boolean;
    current: boolean;
    colorTag: string | null;
    count: number | undefined;
    onClick: (e: React.MouseEvent) => void;
    onToggle: () => void;
    onContextMenu: (e: React.MouseEvent) => void;
}

function TreeRow({ id, row, top, active, current, colorTag, count, onClick, onToggle, onContextMenu }: TreeRowProps) {
    const expandable =
        row.type === "connection" ||
        row.type === "schema" ||
        row.type === "group" ||
        (row.type === "object" && row.expandable);
    const expanded = "expanded" in row ? row.expanded : undefined;

    let icon: ReactNode = null;
    let label: ReactNode = null;
    let right: ReactNode = null;
    let title: string | undefined;

    switch (row.type) {
        case "connection": {
            const tag = colorTagVar(colorTag);
            icon = <EngineIcon engine={row.connection.engine} size={13} />;
            label = row.connection.name;
            right = (
                <span className={styles.stats}>
                    {current && <span className={styles.faint}>active</span>}
                    {tag && <span className={styles.tag} style={{ background: tag }} aria-hidden />}
                </span>
            );
            title = current ? `${row.connection.name}\nActive connection` : row.connection.name;
            break;
        }
        case "schema":
            icon = <Database size={13} />;
            label = row.schema;
            break;
        case "group":
            label = GROUP_LABELS[row.kind];
            right = <span className={styles.faint}>{row.count}</span>;
            break;
        case "object": {
            const o = row.object;
            icon = OBJECT_ICONS[o.kind];
            // Name and detail clip separately, so each ellipsis takes its own color; the detail gives way first.
            const detail =
                o.kind === "function"
                    ? `(${o.detail ?? ""})`
                    : (o.kind === "index" || o.kind === "trigger") && o.parent
                      ? `on ${o.parent}`
                      : null;
            label = (
                <span className={styles.labelParts}>
                    <span className={styles.labelName}>{o.name}</span>
                    {detail && <span className={styles.labelDetail}>{detail}</span>}
                </span>
            );
            const rows =
                count !== undefined
                    ? formatCount(count)
                    : o.estimated_rows != null
                      ? `~${compactCount(o.estimated_rows)}`
                      : null;
            right = (
                <span className={styles.stats}>
                    {rows && <span>{rows}</span>}
                    {o.size_bytes != null && o.size_bytes > 0 && (
                        <span className={styles.faint}>{formatBytes(o.size_bytes)}</span>
                    )}
                </span>
            );
            title = [
                `${displayName(o.schema, o.name)} (${GROUP_LABELS[o.kind].replace(/s$/, "").toLowerCase()})`,
                count !== undefined
                    ? `${formatCount(count)} rows (exact)`
                    : o.estimated_rows != null
                      ? `About ${formatCount(o.estimated_rows)} rows`
                      : null,
                o.size_bytes != null ? formatBytes(o.size_bytes) : null,
            ]
                .filter(Boolean)
                .join("\n");
            break;
        }
        case "column":
            icon = row.column.pk_ordinal != null ? <KeyRound size={11} className={styles.key} /> : <span />;
            label = row.column.name;
            right = <span className={styles.faint}>{row.column.type_name}</span>;
            title = `${row.column.name} ${row.column.type_name}${row.column.nullable ? "" : " not null"}`;
            break;
        case "note":
            label = <span className={styles.faint}>{row.text}</span>;
            break;
    }

    return (
        // biome-ignore lint/a11y/useFocusableInteractive: focus stays on the tree (aria-activedescendant)
        // biome-ignore lint/a11y/useKeyWithClickEvents: the tree handles the keyboard
        <div
            id={id}
            role="treeitem"
            aria-level={row.level}
            aria-expanded={expandable ? expanded : undefined}
            aria-selected={active}
            className={styles.row}
            data-active={active || undefined}
            data-kind={row.type}
            style={{ top, paddingLeft: 6 + (row.level - 1) * 14 }}
            title={title}
            onClick={onClick}
            onContextMenu={onContextMenu}
        >
            {/* biome-ignore lint/a11y/noStaticElementInteractions: mouse shortcut; the tree's arrows expand */}
            {/* biome-ignore lint/a11y/useKeyWithClickEvents: the tree handles the keyboard */}
            <span
                className={styles.chevron}
                onClick={(e) => {
                    if (!expandable) return;
                    e.stopPropagation();
                    onToggle();
                }}
            >
                {expandable && (expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />)}
            </span>
            {icon && <span className={styles.icon}>{icon}</span>}
            <span className={styles.label}>{label}</span>
            {right}
        </div>
    );
}
