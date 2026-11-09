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

import { ContextMenu, type MenuEntry } from "@/components/ui/Menu";
import { Select } from "@/components/ui/Select";
import { useConnectFlow } from "@/hooks/useConnectFlow";
import type { ConnectionsState } from "@/hooks/useConnections";
import { useSchema } from "@/hooks/useSchema";
import { useStore } from "@/hooks/useStore";
import { explorerConnection } from "@/lib/connections/activeConnection";
import { folderPath } from "@/lib/connections/connectionTree";
import { buildRows, defaultExpanded, type ExplorerRow, GROUP_LABELS, objectId, parentIndex } from "@/lib/explorer/tree";
import { backend, errorMessage } from "@/lib/ipc/backend";
import type { ObjectKind, SchemaColumn, SchemaObject } from "@/lib/ipc/bindings";
import { refreshSchema, tableColumns } from "@/lib/schema/schemaStore";
import { log } from "@/lib/shell/log";
import { tooltip } from "@/lib/shell/tooltip";
import { displayName, type TableRef } from "@/lib/tabs/tableTabs";
import { compactCount, formatBytes, formatCount } from "@/lib/util/numbers";

import styles from "@/components/explorer/ExplorerPanel.module.css";
import panels from "@/components/shell/Panels.module.css";
import controls from "@/components/ui/controls.module.css";

/**
 * The Explorer side panel: the cached schema of one connection as a tree, with a filter, row count
 * estimates and sizes, and a context menu. Works from the cache while disconnected; actions that
 * need the database connect first.
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

export function ExplorerPanel({ connections, onOpenTable }: ExplorerPanelProps) {
    const chosen = useStore(explorerConnection);
    const connectionId = chosen && connections.index.connections.has(chosen) ? chosen : null;
    const connection = connectionId ? connections.index.connections.get(connectionId) : undefined;
    const engine = connection?.engine ?? "postgres";
    const schema = useSchema(connectionId);
    const connected = connections.sessions.some((s) => s.background && s.connection_id === connectionId);

    const [filter, setFilter] = useState("");
    const [expandedBy, setExpandedBy] = useState<Map<string, Set<string>>>(new Map());
    const [columns, setColumns] = useState<Map<string, SchemaColumn[]>>(new Map());
    const [counts, setCounts] = useState<Map<string, number>>(new Map());
    const [active, setActive] = useState(0);
    const [menu, setMenu] = useState<{ x: number; y: number; row: ExplorerRow } | null>(null);
    const [problem, setProblem] = useState<string | null>(null);
    const [scroll, setScroll] = useState({ top: 0, height: 400 });
    const listRef = useRef<HTMLDivElement>(null);
    const connectFlow = useConnectFlow(connections.persistentSecrets, setProblem);

    const expanded = (connectionId && expandedBy.get(connectionId)) || defaultExpanded(engine);
    const setExpanded = (next: Set<string>) => {
        if (connectionId) setExpandedBy((m) => new Map(m).set(connectionId, next));
    };

    // Columns come from the cache; a schema reload drops the loaded ones.
    const version = schema?.version ?? 0;
    // biome-ignore lint/correctness/useExhaustiveDependencies: reset per connection and schema version
    useEffect(() => {
        setColumns(new Map());
        setCounts(new Map());
    }, [connectionId, version]);

    const objects = schema?.objects ?? [];
    const rows = useMemo(
        () => buildRows(objects, engine, expanded, columns, filter),
        [objects, engine, expanded, columns, filter],
    );

    useEffect(() => {
        if (active >= rows.length) setActive(Math.max(0, rows.length - 1));
    }, [rows.length, active]);

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

    const connect = async () => {
        if (!connection) return false;
        if (connected) return true;
        return (await connectFlow.connect(connection, {}, "background")) !== null;
    };

    const toggle = (row: ExplorerRow) => {
        if (row.type === "column" || row.type === "note") return;
        if (row.type === "object" && !row.expandable) return;
        const next = new Set(expanded);
        if (next.has(row.id) || (row.type !== "object" && row.expanded)) {
            next.delete(row.id);
        } else {
            next.add(row.id);
            if (row.type === "object" && connectionId && !columns.has(row.id)) {
                const { schema: s, name } = row.object;
                void tableColumns(connectionId, s, name).then((cols) =>
                    setColumns((m) => new Map(m).set(row.id, cols)),
                );
            }
        }
        setExpanded(next);
    };

    const tableRef = (object: SchemaObject): TableRef | null =>
        connectionId && opensAsTable(object.kind)
            ? { connectionId, schema: object.schema, name: object.name, kind: object.kind }
            : null;

    const open = (row: ExplorerRow, preview: boolean) => {
        if (row.type !== "object") return;
        const ref = tableRef(row.object);
        if (ref) onOpenTable(ref, preview);
    };

    const source = connection?.name ?? "Explorer";

    const copyDdl = async (object: SchemaObject) => {
        if (!connectionId || !(await connect())) return;
        try {
            const ddl = await backend.objectDdl(connectionId, {
                schema: object.schema,
                name: object.name,
                kind: object.kind,
                detail: object.detail,
            });
            await navigator.clipboard.writeText(ddl);
            log({ kind: "background", source, text: `Copied the DDL of ${object.schema}.${object.name}` });
        } catch (e) {
            setProblem(errorMessage(e));
        }
    };

    const countRows = async (object: SchemaObject) => {
        if (!connectionId || !(await connect())) return;
        try {
            const result = await backend.countRows(connectionId, {
                schema: object.schema,
                name: object.name,
                filter: null,
                order: null,
            });
            const count = result.count ?? 0;
            setCounts((m) => new Map(m).set(objectId(object), count));
            log({
                kind: "background",
                source,
                text: result.sql.replace(/\s+/g, " ").trim(),
                detail: `${formatCount(count)} rows, ${Math.round(result.duration_ms ?? 0)} ms`,
            });
        } catch (e) {
            setProblem(errorMessage(e));
        }
    };

    const menuEntries = (row: ExplorerRow): MenuEntry[] => {
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
        const ref = tableRef(object);
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
            { label: "Copy DDL", onSelect: () => void copyDdl(object) },
        );
        if (ref) entries.push({ label: "Count rows", onSelect: () => void countRows(object) });
        return entries;
    };

    const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
        const row = rows[active];
        const move = (to: number) => {
            e.preventDefault();
            setActive(Math.max(0, Math.min(rows.length - 1, to)));
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
                else setActive(Math.max(0, parentIndex(rows, active)));
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
        const row = rows[active];
        const el = row ? document.getElementById(rowId(row)) : null;
        const rect = el?.getBoundingClientRect();
        if (row) setMenu({ x: (rect?.left ?? 0) + 24, y: rect?.bottom ?? 0, row });
    };

    const rowId = (row: ExplorerRow) => `explorer-${connectionId}-${row.id}`;

    const connectionOptions = useMemo(() => {
        const list = [...connections.index.connections.values()].map((c) => {
            const folder = folderPath(connections.index, c.folder_id).join(" / ");
            return { value: c.id, label: folder ? `${folder} / ${c.name}` : c.name };
        });
        list.sort((a, b) => a.label.localeCompare(b.label));
        return [{ value: "", label: "Choose a connection", muted: true }, ...list];
    }, [connections.index]);

    const first = Math.max(0, Math.floor(scroll.top / ROW_HEIGHT) - 10);
    const last = Math.min(rows.length - 1, Math.ceil((scroll.top + scroll.height) / ROW_HEIGHT) + 10);
    const activeRow = rows[active];

    const status = !connection
        ? null
        : schema?.loading || (connected && !schema?.refreshedAt)
          ? "Loading the schema…"
          : !connected && schema?.refreshedAt
            ? `Not connected. Cached ${new Date(schema.refreshedAt).toLocaleString()}.`
            : !connected
              ? "Not connected."
              : null;

    return (
        <div className={styles.panel}>
            <h2 className={panels.panelHeader}>Explorer</h2>
            <div className={styles.controls}>
                <span id="explorer-connection-label" className="visually-hidden">
                    Connection
                </span>
                <div className={styles.picker}>
                    <Select
                        value={connectionId ?? ""}
                        options={connectionOptions}
                        labelledBy="explorer-connection-label"
                        mono
                        onChange={(id) => explorerConnection.set(id || null)}
                    />
                </div>
                <button
                    type="button"
                    className={controls.iconButton}
                    aria-label="Refresh the schema"
                    disabled={!connection || schema?.loading}
                    onClick={() =>
                        void (async () => {
                            if (connectionId && (await connect())) await refreshSchema(connectionId);
                        })()
                    }
                    {...tooltip("Refresh the schema")}
                >
                    <RefreshCw size={13} />
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
                        setActive(0);
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

            {status && (
                <div className={styles.status}>
                    <span>{status}</span>
                    {!connected && (
                        <button type="button" className={controls.ghost} onClick={() => void connect()}>
                            <Plug size={12} />
                            Connect
                        </button>
                    )}
                </div>
            )}
            {(problem || schema?.error) && (
                <p className={controls.error} role="alert">
                    {problem ?? schema?.error}
                </p>
            )}

            {!connection ? (
                <p className={panels.placeholder}>Choose a connection to browse its schemas and tables.</p>
            ) : (
                <div
                    ref={listRef}
                    className={styles.tree}
                    role="tree"
                    aria-label={`${connection.name} schema`}
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
                            return (
                                <TreeRow
                                    key={row.id}
                                    id={rowId(row)}
                                    row={row}
                                    top={index * ROW_HEIGHT}
                                    active={index === active}
                                    count={row.type === "object" ? counts.get(row.id) : undefined}
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
                    {rows.length === 0 && schema?.refreshedAt && (
                        <p className={panels.placeholder}>{filter ? "No objects match." : "No objects."}</p>
                    )}
                </div>
            )}

            {menu && (
                <ContextMenu
                    label="Object"
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
    row: ExplorerRow;
    top: number;
    active: boolean;
    count: number | undefined;
    onClick: (e: React.MouseEvent) => void;
    onToggle: () => void;
    onContextMenu: (e: React.MouseEvent) => void;
}

function TreeRow({ id, row, top, active, count, onClick, onToggle, onContextMenu }: TreeRowProps) {
    const expandable = row.type === "schema" || row.type === "group" || (row.type === "object" && row.expandable);
    const expanded = "expanded" in row ? row.expanded : undefined;

    let icon: ReactNode = null;
    let label: ReactNode = null;
    let right: ReactNode = null;
    let title: string | undefined;

    switch (row.type) {
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
