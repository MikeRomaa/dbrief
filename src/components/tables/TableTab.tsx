import { save as chooseSaveFile } from "@tauri-apps/plugin-dialog";
import {
    ChevronFirst,
    ChevronLast,
    ChevronLeft,
    ChevronRight,
    ChevronUp,
    Columns3,
    Download,
    Eye,
    EyeOff,
    Lock,
    Plus,
    RefreshCw,
    Search,
    SquareSplitHorizontal,
    TriangleAlert,
    X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { DataGrid } from "@/components/grid/DataGrid";
import type { TabRuntime } from "@/components/scripts/ScriptTab";
import { StagedBar } from "@/components/tables/StagedBar";
import { type StructureKind, StructureView } from "@/components/tables/StructureView";
import { MenuButton, type MenuEntry } from "@/components/ui/Menu";
import { useConnectFlow } from "@/hooks/useConnectFlow";
import type { ConnectionsState } from "@/hooks/useConnections";
import { useSchema } from "@/hooks/useSchema";
import { useSessionClosed } from "@/hooks/useSessionClosed";
import { useStore } from "@/hooks/useStore";
import { useTableEditing } from "@/hooks/useTableEditing";
import { activeConnection } from "@/lib/connections/activeConnection";
import { plural } from "@/lib/connections/connectionFormat";
import {
    type ColumnLayout,
    displayOrder,
    EMPTY_LAYOUT,
    parseLayout,
    serializeLayout,
    setHidden,
} from "@/lib/grid/columns";
import { inspectorTarget } from "@/lib/grid/inspector";
import { at, type Selection } from "@/lib/grid/selection";
import { backend, errorMessage, RunFailure, type Settings } from "@/lib/ipc/backend";
import type { CopyFormat, ExportFormat, SessionInfo, TablePage, TableQuery_Deserialize } from "@/lib/ipc/bindings";
import { tableColumns } from "@/lib/schema/schemaStore";
import { log } from "@/lib/shell/log";
import { tooltip } from "@/lib/shell/tooltip";
import { displayName, requestView, revealColumn, type TableRef, tableKey } from "@/lib/tabs/tableTabs";
import { debounce } from "@/lib/util/debounce";
import { compactCount, formatCount } from "@/lib/util/numbers";

import styles from "@/components/tables/TableTab.module.css";
import controls from "@/components/ui/controls.module.css";

/**
 * A table tab: the data grid and the structure views of one table or view. The grid runs on the
 * tab's own session, which also holds its transaction; counts, structure and the row identity for
 * editing run on the connection's background session. Editing is in `useTableEditing`.
 */
interface TableTabProps {
    table: TableRef;
    active: boolean;
    connections: ConnectionsState;
    settings: Settings;
    onEdited: () => void;
    onRuntime: (runtime: TabRuntime) => void;
}

type View = "data" | StructureKind;

const VIEWS: { value: View; label: string }[] = [
    { value: "data", label: "Data" },
    { value: "columns", label: "Columns" },
    { value: "indices", label: "Indices" },
    { value: "constraints", label: "Constraints" },
    { value: "triggers", label: "Triggers" },
    { value: "ddl", label: "DDL" },
];

/** Unfiltered tables estimated at this many rows or more aren't counted until asked. */
const COUNT_LIMIT = 1_000_000;

interface Total {
    count: number;
    exact: boolean;
    loading: boolean;
    /** The filter the count is for. */
    filter: string;
}

const oneLine = (sql: string) => sql.replace(/\s+/g, " ").trim();

export function TableTab({ table, active, connections, settings, onEdited, onRuntime }: TableTabProps) {
    const key = tableKey(table);
    const source = displayName(table.schema, table.name);
    const connection = connections.index.connections.get(table.connectionId);
    const connected = connections.sessions.some((s) => s.background && s.connection_id === table.connectionId);
    const schema = useSchema(table.connectionId);
    const object = schema?.objects.find(
        (o) => o.schema === table.schema && o.name === table.name && o.kind === table.kind,
    );
    const missing = !!schema?.refreshedAt && !object && !schema.loading;
    const pageSize = Math.max(1, settings.data_grid.page_size);

    const [view, setView] = useState<View>("data");
    const [session, setSession] = useState<SessionInfo | null>(null);
    const [problem, setProblem] = useState<string | null>(null);
    const [whereDraft, setWhereDraft] = useState("");
    const [orderDraft, setOrderDraft] = useState("");
    const [query, setQuery] = useState({ filter: "", order: "" });
    const [offset, setOffset] = useState(0);
    const [page, setPage] = useState<TablePage | null>(null);
    const [loading, setLoading] = useState(false);
    const [total, setTotal] = useState<Total | null>(null);
    const [layout, setLayout] = useState<ColumnLayout>(EMPTY_LAYOUT);
    const [keyColumns, setKeyColumns] = useState<ReadonlySet<string>>(new Set());
    const [selection, setSelection] = useState<Selection>(at(0, 0));
    const [transposed, setTransposed] = useState(false);
    const [find, setFind] = useState<{ open: boolean; text: string; matches: [number, number][]; current: number }>({
        open: false,
        text: "",
        matches: [],
        current: 0,
    });
    const findRef = useRef<HTMLInputElement>(null);
    const started = useRef(false);
    const rowidRef = useRef<string | null>(null);
    const connectFlow = useConnectFlow(connections.persistentSecrets, setProblem);

    const tableQuery = (q = query): TableQuery_Deserialize => ({
        schema: table.schema,
        name: table.name,
        filter: q.filter.trim() || null,
        order: q.order.trim() || null,
    });

    // The session as of now, for calls made before the next render.
    const liveSession = useRef<SessionInfo | null>(null);
    const ensureSession = async (): Promise<SessionInfo | null> => {
        if (liveSession.current) return liveSession.current;
        if (!connection) {
            setProblem("This connection no longer exists.");
            return null;
        }
        const opened = await connectFlow.connect(connection);
        if (opened) {
            liveSession.current = opened;
            setSession(opened);
            setProblem(null);
        }
        return opened;
    };

    const ensureConnected = async (): Promise<boolean> => {
        if (connected) return true;
        if (!connection) return false;
        return (await connectFlow.connect(connection, {}, "background")) !== null;
    };

    const runCount = async (filter: string) => {
        const estimate = object?.estimated_rows ?? null;
        if (!filter.trim() && estimate !== null && estimate >= COUNT_LIMIT) {
            setTotal({ count: estimate, exact: false, loading: false, filter });
            return;
        }
        await countNow(filter);
    };

    const countNow = async (filter: string) => {
        setTotal((t) => ({ count: t?.count ?? 0, exact: false, loading: true, filter }));
        try {
            const result = await backend.countRows(table.connectionId, tableQuery({ filter, order: "" }));
            const count = result.count ?? 0;
            log({
                kind: "background",
                source,
                text: oneLine(result.sql),
                detail: `${formatCount(count)} rows, ${Math.round(result.duration_ms ?? 0)} ms`,
            });
            // A newer filter may have started its own count meanwhile.
            setTotal((t) => (t && t.filter !== filter ? t : { count, exact: true, loading: false, filter }));
        } catch (e) {
            setTotal(null);
            log({ kind: "error", source, text: `Counting rows failed: ${errorMessage(e)}` });
        }
    };

    const load = async (next: { filter: string; order: string }, nextOffset: number) => {
        const current = await ensureSession();
        if (!current) return;
        setLoading(true);
        try {
            const result = await backend.tablePage(
                current.id,
                table.kind,
                tableQuery(next),
                rowidRef.current,
                pageSize,
                nextOffset,
            );
            setPage(result);
            setOffset(nextOffset);
            setProblem(null);
            setSelection((s) =>
                s.focus.row < result.page.cells.length ? s : at(Math.max(0, result.page.cells.length - 1), s.focus.col),
            );
            setFind((f) => ({ ...f, matches: [], current: 0 }));
            log({
                kind: "statement",
                source,
                text: oneLine(result.sql),
                detail: `${plural(result.page.cells.length, "row")}, ${Math.round(result.page.duration_ms ?? 0)} ms`,
            });
        } catch (e) {
            const message =
                e instanceof RunFailure && e.error.kind === "query" ? e.error.error.message : errorMessage(e);
            setProblem(message);
            log({ kind: "error", source, text: `${message} — ${source}` });
            if (e instanceof RunFailure && e.error.kind === "transaction-lost") {
                await backend.acknowledgeLostTransaction(current.id).catch(() => {});
            }
        } finally {
            setLoading(false);
        }
    };

    const apply = (next: { filter: string; order: string }) =>
        edits.guard(() => {
            const filterChanged = next.filter.trim() !== query.filter.trim();
            setQuery(next);
            onEdited();
            void load(next, 0);
            if (filterChanged || !total) void runCount(next.filter);
        });

    /** Loads another page, asking first when changes are staged. */
    const goTo = (nextOffset: number) => edits.guard(() => void load(query, nextOffset));

    // Load the first page, the layout and the key columns once the tab is first shown.
    // biome-ignore lint/correctness/useExhaustiveDependencies: first activation only
    useEffect(() => {
        if (!active || started.current || missing) return;
        started.current = true;
        void backend
            .tableLayout(table.connectionId, table.schema, table.name)
            .then((raw) => setLayout(parseLayout(raw)))
            .catch(() => {});
        void tableColumns(table.connectionId, table.schema, table.name).then((cols) =>
            setKeyColumns(new Set(cols.filter((c) => c.pk_ordinal != null).map((c) => c.name))),
        );
        void (async () => {
            const current = await ensureSession();
            if (!current) return;
            rowidRef.current = await edits.loadInfo();
            await load(query, 0);
            void runCount(query.filter);
        })();
    }, [active, missing]);

    useEffect(() => {
        if (active) activeConnection.set(table.connectionId);
    }, [active, table.connectionId]);

    // A disconnect closes this tab's session too.
    useSessionClosed(session, connections.sessions, () => {
        liveSession.current = null;
        setSession(null);
    });

    const saveLayout = useMemo(
        () =>
            debounce(
                (next: ColumnLayout) =>
                    void backend
                        .setTableLayout(table.connectionId, table.schema, table.name, serializeLayout(next))
                        .catch(() => {}),
                400,
            ),
        [table.connectionId, table.schema, table.name],
    );
    const changeLayout = (next: ColumnLayout) => {
        setLayout(next);
        saveLayout(next);
    };

    const columns = page?.page.columns ?? [];
    const names = useMemo(() => columns.map((c) => c.name), [columns]);
    const visible = useMemo(() => displayOrder(names, layout), [names, layout]);

    const edits = useTableEditing({
        table,
        source,
        connection,
        active,
        session,
        page,
        offset,
        visible,
        selection,
        setSelection,
        reload: async () => {
            await load(query, offset);
            void runCount(query.filter);
        },
        setProblem,
    });

    // The inspector follows the active cell of the active tab, staged values included.
    const focusColumn = visible[selection.focus.col];
    const focusRow = selection.focus.row;
    const focusCells = edits.cells[focusRow];
    // biome-ignore lint/correctness/useExhaustiveDependencies: the staging changes what the inspector edits
    useEffect(() => {
        if (!active) return;
        if (!session || !page || focusColumn === undefined || !focusCells || view !== "data") {
            inspectorTarget.set(null);
            return;
        }
        const pageRow = focusRow < page.page.cells.length ? focusRow : null;
        const shown = focusCells.map((cell, i) => {
            const staged = edits.editing?.display(focusRow, i);
            return staged ? (staged.kind === "value" ? staged.cell : null) : cell;
        });
        inspectorTarget.set({
            sessionId: session.id,
            columns: page.page.columns,
            cells: shown,
            row: pageRow,
            column: focusColumn,
            rowNumber: edits.rowLabelOf(focusRow),
            edit: edits.inspectorEdit(focusRow, focusColumn),
            editFor: (column) => edits.inspectorEdit(focusRow, column),
        });
    }, [active, session, page, focusColumn, focusCells, focusRow, offset, view, edits.staging, edits.info]);
    useEffect(() => () => inspectorTarget.set(null), []);

    // The Explorer's "Open structure" opens the Columns view.
    const requested = useStore(requestView);
    useEffect(() => {
        if (requested?.key !== key) return;
        requestView.set(null);
        setView(requested.view);
    }, [requested, key]);

    // Search results for a column scroll to it.
    const reveal = useStore(revealColumn);
    useEffect(() => {
        if (!reveal || reveal.key !== key || names.length === 0) return;
        revealColumn.set(null);
        setView("data");
        let nextLayout = layout;
        if (layout.hidden.includes(reveal.column)) {
            nextLayout = setHidden(layout, reveal.column, false);
            changeLayout(nextLayout);
        }
        const d = displayOrder(names, nextLayout).findIndex((i) => names[i] === reveal.column);
        if (d >= 0) setSelection(at(selection.focus.row, d));
    });

    const copy = async (format: CopyFormat, rows: number[], cols: number[]) => {
        if (!session) return;
        try {
            const text = await backend.copyPage(session.id, rows, cols, format, tableQuery());
            await navigator.clipboard.writeText(text);
        } catch (e) {
            setProblem(`Could not copy: ${errorMessage(e)}`);
        }
    };

    const exportTable = async (format: ExportFormat) => {
        const current = await ensureSession();
        if (!current) return;
        const extension = { csv: "csv", json: "json", sql: "sql" }[format];
        const target = await chooseSaveFile({
            title: `Export ${source}`,
            defaultPath: `${table.name}.${extension}`,
            filters: [{ name: format.toUpperCase(), extensions: [extension] }],
        });
        if (!target) return;
        try {
            const rows = await backend.exportTable(current.id, table.kind, tableQuery(), format, target);
            log({ kind: "statement", source, text: `Exported ${plural(rows, "row")} to ${target}` });
        } catch (e) {
            setProblem(`Export failed: ${errorMessage(e)}`);
        }
    };

    // Find runs over the full values of the loaded page, in the backend.
    const runFind = useMemo(
        () =>
            debounce(async (sessionId: string, text: string) => {
                const found = await backend.findInPage(sessionId, text).catch(() => []);
                setFind((f) => (f.text === text ? { ...f, matches: found, current: 0 } : f));
            }, 120),
        [],
    );
    const matchSet = useMemo(() => new Set(find.matches.map(([r, c]) => `${r}:${c}`)), [find.matches]);
    const currentMatch = find.matches[find.current];
    const goToMatch = (index: number) => {
        const match = find.matches[index];
        if (!match) return;
        const d = visible.indexOf(match[1]);
        setFind((f) => ({ ...f, current: index }));
        if (d >= 0) setSelection(at(match[0], d));
    };

    const onKeyDown = (e: React.KeyboardEvent) => {
        const mod = e.metaKey || e.ctrlKey;
        if (mod && !e.shiftKey && e.key.toLowerCase() === "s" && view === "data") {
            e.preventDefault();
            edits.save();
            return;
        }
        if (mod && e.key.toLowerCase() === "f" && view === "data") {
            e.preventDefault();
            setFind((f) => ({ ...f, open: true }));
            requestAnimationFrame(() => findRef.current?.select());
        }
    };

    // Report what closing this tab involves: an open transaction, staged changes.
    const sessionId = session?.id ?? null;
    const discardStaged = useRef(edits.discard);
    discardStaged.current = edits.discard;
    useEffect(() => {
        onRuntime({
            connectionId: table.connectionId,
            sessionId,
            inTransaction: edits.txOpen,
            staged: edits.counts.total,
            discardStaged: () => discardStaged.current(),
            flush: async () => {},
            reloadFromDisk: async () => {},
        });
    }, [sessionId, onRuntime, table.connectionId, edits.txOpen, edits.counts.total]);

    const sessionRef = useRef(session);
    sessionRef.current = session;
    useEffect(
        () => () => {
            if (sessionRef.current) void backend.disconnect(sessionRef.current.id).catch(() => {});
        },
        [],
    );

    const rows = page?.page.cells.length ?? 0;
    const exactTotal = total?.exact ? total.count : null;
    const lastOffset = exactTotal !== null ? Math.max(0, Math.floor((exactTotal - 1) / pageSize) * pageSize) : null;
    const hasNext = exactTotal !== null ? offset + rows < exactTotal : rows >= pageSize;
    const range = rows === 0 ? "0 rows" : `${formatCount(offset + 1)}–${formatCount(offset + rows)}`;
    const of = !total
        ? ""
        : total.loading
          ? " of …"
          : total.exact
            ? ` of ${formatCount(total.count)}`
            : ` of ~${compactCount(total.count)}`;

    const columnsMenu: MenuEntry[] = names.map((name) => {
        const hidden = layout.hidden.includes(name);
        return {
            label: name,
            icon: hidden ? <EyeOff size={13} /> : <Eye size={13} />,
            hint: hidden ? "Hidden" : undefined,
            disabled: !hidden && visible.length <= 1,
            onSelect: () => changeLayout(setHidden(layout, name, !hidden)),
        };
    });
    const exportMenu: MenuEntry[] = [
        { label: "CSV", onSelect: () => void exportTable("csv") },
        { label: "JSON", onSelect: () => void exportTable("json") },
        { label: "SQL INSERT statements", onSelect: () => void exportTable("sql") },
        "separator",
        {
            label: "Copy page as TSV",
            disabled: rows === 0,
            onSelect: () =>
                void copy(
                    "tsv-with-headers",
                    Array.from({ length: rows }, (_, i) => i),
                    visible,
                ),
        },
    ];

    const objectRef = { schema: table.schema, name: table.name, kind: table.kind, detail: null };

    if (!connection) {
        return (
            <div className={styles.tab} hidden={!active}>
                <p className={styles.message}>The connection of this tab was removed.</p>
            </div>
        );
    }

    return (
        // biome-ignore lint/a11y/noStaticElementInteractions: ⌘F for the find bar anywhere in the tab
        <div className={styles.tab} hidden={!active} onKeyDown={onKeyDown}>
            <div className={styles.views} role="tablist" aria-label={`${source} views`}>
                {VIEWS.map((v) => (
                    <button
                        key={v.value}
                        type="button"
                        role="tab"
                        aria-selected={view === v.value}
                        tabIndex={view === v.value ? 0 : -1}
                        className={styles.viewTab}
                        onClick={() => setView(v.value)}
                        onKeyDown={(e) => {
                            const i = VIEWS.findIndex((x) => x.value === view);
                            const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
                            if (!step) return;
                            e.preventDefault();
                            const next = VIEWS[(i + step + VIEWS.length) % VIEWS.length];
                            if (next) {
                                setView(next.value);
                                const tabs =
                                    e.currentTarget.parentElement?.querySelectorAll<HTMLElement>('[role="tab"]');
                                tabs?.[VIEWS.indexOf(next)]?.focus();
                            }
                        }}
                    >
                        {v.label}
                    </button>
                ))}
                <span className={styles.spacer} />
                <span className={styles.meta}>
                    {connection.name} · {source}
                </span>
            </div>

            {missing && (
                <p className={styles.message}>
                    {table.kind === "table" ? "This table" : "This view"} no longer exists in the cached schema.
                </p>
            )}

            {!missing && view === "data" && (
                <>
                    <div className={styles.toolbar} role="toolbar" aria-label="Data">
                        <label className={styles.clause}>
                            <span className={styles.clauseLabel}>WHERE</span>
                            <input
                                className={`${controls.input} ${styles.clauseInput}`}
                                value={whereDraft}
                                placeholder="filter, e.g. status = 'open'"
                                aria-label="WHERE filter"
                                spellCheck={false}
                                onChange={(e) => setWhereDraft(e.target.value)}
                                onKeyDown={(e) => {
                                    if (e.key === "Enter") apply({ filter: whereDraft, order: orderDraft });
                                    if (e.key === "Escape" && whereDraft) {
                                        setWhereDraft("");
                                        apply({ filter: "", order: orderDraft });
                                    }
                                }}
                            />
                        </label>
                        <label className={styles.clause}>
                            <span className={styles.clauseLabel}>ORDER BY</span>
                            <input
                                className={`${controls.input} ${styles.clauseInput} ${styles.orderInput}`}
                                value={orderDraft}
                                placeholder="sort"
                                aria-label="ORDER BY"
                                spellCheck={false}
                                onChange={(e) => setOrderDraft(e.target.value)}
                                onKeyDown={(e) => {
                                    if (e.key === "Enter") apply({ filter: whereDraft, order: orderDraft });
                                }}
                            />
                        </label>
                        <button
                            type="button"
                            className={controls.button}
                            disabled={loading}
                            onClick={() => apply({ filter: whereDraft, order: orderDraft })}
                            {...tooltip("Apply the filter and sort", { shortcut: "⏎" })}
                        >
                            Apply
                        </button>

                        <span className={styles.spacer} />

                        <span className={styles.paging} aria-live="polite">
                            {range}
                            {of}
                            {total && !total.exact && !total.loading && (
                                <button
                                    type="button"
                                    className={controls.ghost}
                                    onClick={() => void countNow(query.filter)}
                                >
                                    Count
                                </button>
                            )}
                        </span>
                        <button
                            type="button"
                            className={controls.iconButton}
                            aria-label="First page"
                            disabled={loading || offset === 0}
                            onClick={() => goTo(0)}
                        >
                            <ChevronFirst size={14} />
                        </button>
                        <button
                            type="button"
                            className={controls.iconButton}
                            aria-label="Previous page"
                            disabled={loading || offset === 0}
                            onClick={() => goTo(Math.max(0, offset - pageSize))}
                        >
                            <ChevronLeft size={14} />
                        </button>
                        <button
                            type="button"
                            className={controls.iconButton}
                            aria-label="Next page"
                            disabled={loading || !hasNext}
                            onClick={() => goTo(offset + pageSize)}
                        >
                            <ChevronRight size={14} />
                        </button>
                        <button
                            type="button"
                            className={controls.iconButton}
                            aria-label="Last page"
                            disabled={loading || lastOffset === null || offset >= lastOffset}
                            onClick={() => lastOffset !== null && goTo(lastOffset)}
                        >
                            <ChevronLast size={14} />
                        </button>

                        <span className={styles.divider} />

                        {edits.editable && (
                            <button
                                type="button"
                                className={controls.iconButton}
                                aria-label="Add row"
                                onClick={() => edits.editing?.onAction({ kind: "add-row" })}
                                {...tooltip("Add row", { shortcut: "⇧⌘N" })}
                            >
                                <Plus size={14} />
                            </button>
                        )}
                        <MenuButton
                            label={`Transaction mode: ${edits.mode === "manual" ? "Manual" : "Auto"}`}
                            entries={[
                                {
                                    label: "Auto-commit",
                                    hint: edits.mode === "auto" ? "✓" : undefined,
                                    disabled: edits.txOpen,
                                    onSelect: () => void edits.changeMode("auto"),
                                },
                                {
                                    label: "Manual",
                                    hint: edits.mode === "manual" ? "✓" : undefined,
                                    disabled: edits.txOpen,
                                    onSelect: () => void edits.changeMode("manual"),
                                },
                            ]}
                            className={controls.ghost}
                            attrs={tooltip(
                                edits.txOpen
                                    ? "Commit or roll back before changing the mode"
                                    : "Auto-commit commits each change; Manual keeps a transaction open",
                            )}
                        >
                            Tx: {edits.mode === "manual" ? "Manual" : "Auto"}
                        </MenuButton>
                        <button
                            type="button"
                            className={`${controls.iconButton} ${styles.toggle}`}
                            aria-label="Transpose"
                            aria-pressed={transposed}
                            onClick={() => setTransposed((t) => !t)}
                            {...tooltip(transposed ? "Show rows as rows" : "Transpose: show rows as columns")}
                        >
                            <SquareSplitHorizontal size={14} />
                        </button>
                        <MenuButton
                            label="Columns"
                            entries={columnsMenu}
                            align="end"
                            className={controls.iconButton}
                            attrs={tooltip("Show or hide columns")}
                        >
                            <Columns3 size={14} />
                        </MenuButton>
                        <MenuButton
                            label="Export"
                            entries={exportMenu}
                            align="end"
                            className={controls.iconButton}
                            attrs={tooltip("Export")}
                        >
                            <Download size={14} />
                        </MenuButton>
                        <button
                            type="button"
                            className={controls.iconButton}
                            aria-label="Reload"
                            disabled={loading}
                            onClick={() =>
                                edits.guard(() => {
                                    void (async () => {
                                        rowidRef.current = await edits.loadInfo();
                                        await load(query, offset);
                                        void runCount(query.filter);
                                    })();
                                })
                            }
                            {...tooltip("Reload")}
                        >
                            <RefreshCw size={13} />
                        </button>
                    </div>

                    {edits.txOpen && (
                        <div className={styles.notice} role="status">
                            <span className={styles.txOpen}>Transaction open</span>
                            <span>Changes are visible here until you commit or roll back.</span>
                            <span className={styles.spacer} />
                            <button type="button" className={controls.button} onClick={() => void edits.rollbackTx()}>
                                Roll back
                            </button>
                            <button
                                type="button"
                                className={controls.primary}
                                onClick={() => void edits.commitTx()}
                                {...tooltip("Commit", { shortcut: edits.counts.total ? undefined : "⌘S" })}
                            >
                                Commit
                            </button>
                        </div>
                    )}

                    {edits.info?.read_only && table.kind === "table" && (
                        <p className={styles.readOnly}>
                            <Lock size={12} aria-hidden /> {edits.info.read_only}
                        </p>
                    )}

                    {page?.unordered && (
                        <p className={styles.notice}>
                            <TriangleAlert size={12} aria-hidden /> No primary key and no ORDER BY: rows may move
                            between pages.
                        </p>
                    )}

                    {problem && (
                        <div className={styles.problem} role="alert">
                            <span>{problem}</span>
                            <button type="button" className={controls.ghost} onClick={() => setProblem(null)}>
                                Dismiss
                            </button>
                        </div>
                    )}

                    {find.open && (
                        <div className={styles.find}>
                            <Search size={13} aria-hidden />
                            <input
                                ref={findRef}
                                className={`${controls.input} ${styles.findInput}`}
                                value={find.text}
                                placeholder="Find in the loaded rows"
                                aria-label="Find in the loaded rows"
                                spellCheck={false}
                                onChange={(e) => {
                                    const text = e.target.value;
                                    setFind((f) => ({ ...f, text, matches: [], current: 0 }));
                                    if (session && text) runFind(session.id, text);
                                }}
                                onKeyDown={(e) => {
                                    if (e.key === "Enter") {
                                        e.preventDefault();
                                        const n = find.matches.length;
                                        if (n) goToMatch((find.current + (e.shiftKey ? n - 1 : 1)) % n);
                                    } else if (e.key === "Escape") {
                                        setFind((f) => ({ ...f, open: false, matches: [] }));
                                    }
                                }}
                            />
                            <span className={styles.meta}>
                                {find.text
                                    ? find.matches.length
                                        ? `${find.current + 1} of ${find.matches.length}`
                                        : "No matches"
                                    : ""}
                            </span>
                            <button
                                type="button"
                                className={controls.iconButton}
                                aria-label="Previous match"
                                disabled={find.matches.length === 0}
                                onClick={() =>
                                    goToMatch((find.current + find.matches.length - 1) % find.matches.length)
                                }
                            >
                                <ChevronUp size={14} />
                            </button>
                            <span className={styles.findNote}>Searches this page; use WHERE for the whole table.</span>
                            <button
                                type="button"
                                className={controls.iconButton}
                                aria-label="Close find"
                                onClick={() => setFind((f) => ({ ...f, open: false, matches: [] }))}
                            >
                                <X size={13} />
                            </button>
                        </div>
                    )}

                    {page ? (
                        <DataGrid
                            id={`grid-${key}`}
                            label={`${source} data`}
                            columns={page.page.columns}
                            cells={edits.cells}
                            rowOffset={offset}
                            layout={layout}
                            onLayoutChange={changeLayout}
                            order={query.order}
                            onOrderChange={(order) =>
                                edits.guard(() => {
                                    setOrderDraft(order);
                                    apply({ filter: query.filter, order });
                                })
                            }
                            keyColumns={keyColumns}
                            options={{
                                nullDisplay: settings.data_grid.null_display,
                                jsonTruncation: settings.data_grid.json_truncation,
                                dateFormat: settings.data_grid.date_format,
                            }}
                            selection={selection}
                            onSelectionChange={setSelection}
                            matches={matchSet}
                            currentMatch={currentMatch ? `${currentMatch[0]}:${currentMatch[1]}` : null}
                            onCopy={(format, r, c) => void copy(format, r, c)}
                            editing={edits.editing}
                            transposed={transposed}
                        />
                    ) : (
                        <p className={styles.message}>{loading ? "Loading…" : problem ? "" : "Not loaded yet."}</p>
                    )}

                    {edits.counts.total > 0 && (
                        <StagedBar
                            counts={edits.counts}
                            mode={edits.mode}
                            busy={edits.busy}
                            onRevertAll={edits.discard}
                            onApply={() => void edits.apply()}
                        />
                    )}
                </>
            )}

            {!missing && view !== "data" && (
                <StructureView
                    key={view}
                    view={view}
                    connectionId={table.connectionId}
                    object={objectRef}
                    dialect={connection.engine === "sqlite" ? "sqlite" : "postgres"}
                    source={source}
                    ensureConnected={ensureConnected}
                />
            )}

            {connectFlow.prompt}
            {edits.dialogs}
        </div>
    );
}
