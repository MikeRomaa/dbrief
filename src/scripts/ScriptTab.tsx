import type { EditorView } from "@codemirror/view";
import { save as chooseSaveFile } from "@tauri-apps/plugin-dialog";
import { Play, PlayCircle, ScanSearch, Square, WandSparkles } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { format as formatSql } from "sql-formatter";

import {
    allStatements,
    createSqlEditor,
    type EditorCallbacks,
    hideResult,
    replaceText,
    resultsBetween,
    setAutocomplete,
    setDialect,
    showResult,
    statementsToRun,
} from "@/editor/sqlEditor";
import { useConnectFlow } from "@/hooks/useConnectFlow";
import type { ConnectionsState } from "@/hooks/useConnections";
import { backend, errorMessage, RunFailure, type Settings } from "@/lib/backend";
import type { SessionInfo, TransactionMode, TransactionStatement } from "@/lib/bindings";
import { ACCESS_LABELS, plural } from "@/lib/connectionFormat";
import { folderPath } from "@/lib/connectionTree";
import { log } from "@/lib/log";
import { type Dialect, fillPlaceholders, placeholderKeys, type Statement } from "@/lib/sql/statements";
import { ParamsDialog } from "@/scripts/ParamsDialog";
import { ResultBlock } from "@/scripts/ResultBlock";
import {
    bottomResult,
    createResultStore,
    dropResult,
    type ExportFormat,
    putResult,
    type ResultActions,
} from "@/scripts/results";
import { isScratchpad, readTabText, tabTitle, writeTabText } from "@/scripts/scratchpad";
import { tooltip } from "@/shell/TooltipLayer";
import { Dialog } from "@/ui/Dialog";
import { Segmented } from "@/ui/Segmented";
import { Select } from "@/ui/Select";

import styles from "@/scripts/ScriptTab.module.css";
import controls from "@/ui/controls.module.css";

/** What the tab strip needs to know to close a tab safely; refreshed as the tab changes. */
export interface TabRuntime {
    sessionId: string | null;
    inTransaction: boolean;
    flush: () => Promise<void>;
    reloadFromDisk: () => Promise<void>;
}

/**
 * One script tab: the editor, its toolbar, and the session it runs on. `onEdited` pins a preview
 * tab; `onRuntime` reports what closing the tab has to deal with.
 */
interface ScriptTabProps {
    path: string;
    active: boolean;
    connections: ConnectionsState;
    settings: Settings;
    onEdited: () => void;
    onRuntime: (runtime: TabRuntime) => void;
}

const AUTOSAVE_MS = 700;

const TX_MODES = [
    { value: "auto", label: "Auto" },
    { value: "manual", label: "Manual" },
] as const;

const oneLine = (sql: string) => sql.replace(/\s+/g, " ").trim();

type Pending =
    | { kind: "params"; keys: string[]; resolve: (values: Record<string, string | null> | null) => void }
    | { kind: "confirm-commit"; statements: TransactionStatement[] }
    | { kind: "conflict"; disk: string }
    | { kind: "lost"; message: string };

export function ScriptTab({ path, active, connections, settings, onEdited, onRuntime }: ScriptTabProps) {
    const hostRef = useRef<HTMLDivElement>(null);
    const viewRef = useRef<EditorView | null>(null);
    const savedRef = useRef<string | null>(null);
    const textRef = useRef("");
    const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    const results = useMemo(createResultStore, []);
    const counter = useRef(0);
    const openResult = useRef<string | null>(null);

    const [loadError, setLoadError] = useState<string | null>(null);
    const [problem, setProblem] = useState<string | null>(null);
    const [connectionId, setConnectionId] = useState<string | null>(null);
    const [schema, setSchema] = useState("");
    const [params, setParams] = useState<Record<string, string | null>>({});
    const [session, setSession] = useState<SessionInfo | null>(null);
    const [mode, setMode] = useState<TransactionMode | null>(null);
    const [txOpen, setTxOpen] = useState(false);
    const [running, setRunning] = useState(false);
    const [pending, setPending] = useState<Pending | null>(null);

    const connection = connectionId ? connections.index.connections.get(connectionId) : undefined;
    const dialect: Dialect = connection?.engine === "sqlite" ? "sqlite" : "postgres";
    const effectiveMode: TransactionMode = mode ?? (connection?.manual_transactions ? "manual" : "auto");
    const connectFlow = useConnectFlow(connections.persistentSecrets, setProblem);

    const save = async () => {
        clearTimeout(saveTimer.current);
        const text = textRef.current;
        if (savedRef.current === null || text === savedRef.current) return;
        try {
            await writeTabText(path, text);
            savedRef.current = text;
        } catch (e) {
            setProblem(`Could not save: ${errorMessage(e)}`);
        }
    };

    const reloadFromDisk = async () => {
        // The Scratchpad lives in the app database; nothing outside changes it.
        if (isScratchpad(path)) return;
        let disk: string;
        try {
            disk = await readTabText(path);
        } catch {
            setProblem("The file was deleted or moved outside DBrief. Editing saves it again.");
            savedRef.current = "";
            return;
        }
        // Our own save, or nothing new.
        if (disk === savedRef.current || disk === textRef.current) {
            savedRef.current = disk;
            return;
        }

        const unsaved = textRef.current !== savedRef.current;
        if (unsaved) {
            setPending({ kind: "conflict", disk });
        } else {
            applyDiskVersion(disk);
        }
    };

    const applyDiskVersion = (disk: string) => {
        savedRef.current = disk;
        textRef.current = disk;
        if (viewRef.current) replaceText(viewRef.current, disk);
    };

    // Everything the editor and result blocks call goes through refs, so they always see this render.
    const actionsRef = useRef<ResultActions>(null as unknown as ResultActions);
    const callbacksRef = useRef<EditorCallbacks>(null as unknown as EditorCallbacks);

    const mountResult = (id: string, container: HTMLElement) => {
        const root = createRoot(container);
        root.render(
            <ResultBlock store={results} id={id} actions={actionsProxy} maxRows={settings.editor.inline_result_rows} />,
        );
        // React draws the result after CodeMirror measured the widget, and results grow as rows
        // arrive; CodeMirror has to re-measure, or clicks land on the wrong line.
        const resized = new ResizeObserver(() => viewRef.current?.requestMeasure());
        resized.observe(container);
        return () => {
            resized.disconnect();
            queueMicrotask(() => root.unmount());
        };
    };

    const ensureSession = async (): Promise<SessionInfo | null> => {
        if (session && session.connection_id === connectionId) return session;
        if (!connection) {
            setProblem("Choose a connection in the toolbar to run this script.");
            return null;
        }
        if (session) await backend.disconnect(session.id).catch(() => {});

        const opened = await connectFlow.connect(connection);
        if (!opened) return null;

        setSession(opened);
        setProblem(null);
        void connections.reload();
        await backend.setTransactionMode(opened.id, effectiveMode).catch(() => {});
        if (schema.trim() && connection.engine === "postgres") {
            await backend.setSessionSchema(opened.id, schema.trim()).catch((e) => setProblem(errorMessage(e)));
        }
        return opened;
    };

    const askParams = (keys: string[]) =>
        new Promise<Record<string, string | null> | null>((resolve) => setPending({ kind: "params", keys, resolve }));

    const runOne = async (current: SessionInfo, statement: Statement): Promise<boolean> => {
        const view = viewRef.current;
        if (!view) return false;

        let sql = statement.text;
        const keys = placeholderKeys(sql, dialect);
        if (keys.length > 0) {
            const values = await askParams(keys);
            if (!values) return false;
            setParams((p) => ({ ...p, ...values }));
            void backend.rememberScriptParams(path, values).catch(() => {});
            sql = fillPlaceholders(sql, dialect, values);
        }

        // A statement's new result replaces its old one.
        for (const old of resultsBetween(view, statement.from, statement.end)) {
            hideResult(view, old);
            dropResult(results, old);
        }

        const id = `r${++counter.current}`;
        const index = counter.current;
        putResult(results, { id, index, sql, status: "running", started: Date.now() });
        if (settings.editor.show_results_inline) {
            showResult(view, id, statement.end, mountResult);
        } else {
            bottomResult.set({ tab: path, store: results, id, actions: actionsProxy });
        }
        openResult.current = null;

        try {
            const out = await backend.runStatement(current.id, sql, settings.data_grid.page_size);
            putResult(results, {
                id,
                index,
                sql,
                status: "done",
                output: out,
                columns: out.columns,
                rows: out.rows,
                more: out.more,
                rowsAffected: out.rows_affected,
                loadingMore: false,
            });
            if (out.more) openResult.current = id;

            const summary = out.columns
                ? `${out.more ? `${out.rows.length}+` : out.rows.length} rows`
                : out.rows_affected === null
                  ? "done"
                  : `${plural(out.rows_affected, "row")} affected`;
            log({
                kind: "statement",
                source: tabTitle(path),
                text: oneLine(sql),
                detail: `${summary}, ${Math.round(out.duration_ms ?? 0)} ms`,
            });
            for (const notice of out.notices) {
                log({
                    kind: "notice",
                    source: tabTitle(path),
                    text: `${notice.level.toUpperCase()}: ${notice.message}`,
                });
            }
            if (out.in_transaction !== txOpen) {
                log({
                    kind: "transaction",
                    source: tabTitle(path),
                    text: out.in_transaction ? "BEGIN" : "Transaction ended",
                });
            }
            setTxOpen(out.in_transaction);
            return true;
        } catch (e) {
            const error = e instanceof RunFailure ? e.error : { kind: "failed" as const, message: errorMessage(e) };
            putResult(results, { id, index, sql, status: "failed", error, offset: statement.from });

            const message = error.kind === "query" ? error.error.message : error.message;
            const detail =
                error.kind === "query"
                    ? [
                          error.error.code && `code ${error.error.code}`,
                          error.error.detail,
                          error.error.hint && `hint: ${error.error.hint}`,
                          error.error.position && `position ${error.error.position}`,
                      ]
                          .filter(Boolean)
                          .join(" · ")
                    : undefined;
            log({
                kind: "error",
                source: tabTitle(path),
                text: `${message} — ${oneLine(sql)}`,
                detail: detail || undefined,
            });

            if (error.kind === "transaction-lost") {
                setTxOpen(false);
                setPending({ kind: "lost", message: error.message });
            }
            return false;
        }
    };

    const runStatements = async (list: Statement[]) => {
        if (running || list.length === 0) return;
        const current = await ensureSession();
        if (!current) return;

        setRunning(true);
        try {
            for (const statement of list) {
                if (!(await runOne(current, statement))) break;
            }
        } finally {
            setRunning(false);
        }
    };

    const loadMore = async (id: string) => {
        const entry = results.get().get(id);
        if (!session || entry?.status !== "done") return;
        if (openResult.current !== id) {
            putResult(results, { ...entry, more: false });
            setProblem("Another statement ran since; run this one again to load more rows.");
            return;
        }

        putResult(results, { ...entry, loadingMore: true });
        try {
            const more = await backend.fetchMore(session.id);
            const latest = results.get().get(id);
            if (latest?.status !== "done") return;
            putResult(results, {
                ...latest,
                rows: [...latest.rows, ...more.rows],
                more: more.more,
                rowsAffected: more.rows_affected ?? latest.rowsAffected,
                loadingMore: false,
            });
            if (!more.more) openResult.current = null;
        } catch (e) {
            putResult(results, { ...entry, loadingMore: false, more: false });
            setProblem(errorMessage(e));
        }
    };

    const cancel = () => {
        if (session) void backend.cancelStatement(session.id).catch((e) => setProblem(errorMessage(e)));
    };

    const commit = async (confirmed = false) => {
        if (!session || !txOpen) return;
        if (connection?.confirm_before_commit && !confirmed) {
            const state = await backend.transactionState(session.id).catch(() => null);
            setPending({ kind: "confirm-commit", statements: state?.statements ?? [] });
            return;
        }
        try {
            await backend.commit(session.id);
            log({ kind: "transaction", source: tabTitle(path), text: "COMMIT" });
        } catch (e) {
            log({ kind: "error", source: tabTitle(path), text: `COMMIT failed: ${errorMessage(e)}` });
            setProblem(errorMessage(e));
        }
        setTxOpen(false);
    };

    const rollback = async () => {
        if (!session || !txOpen) return;
        try {
            await backend.rollback(session.id);
            log({ kind: "transaction", source: tabTitle(path), text: "ROLLBACK" });
        } catch (e) {
            setProblem(errorMessage(e));
        }
        setTxOpen(false);
    };

    const format = (whole = false) => {
        const view = viewRef.current;
        if (!view) return;
        const { from, to } = whole ? { from: 0, to: 0 } : view.state.selection.main;
        const source = from === to ? view.state.doc.toString() : view.state.sliceDoc(from, to);
        try {
            const formatted = formatSql(source, {
                language: dialect === "sqlite" ? "sqlite" : "postgresql",
                tabWidth: 4,
            });
            replaceText(view, formatted, from !== to);
        } catch (e) {
            setProblem(`Could not format: ${errorMessage(e)}`);
        }
    };

    const exportResult = async (id: string, format: ExportFormat) => {
        const entry = results.get().get(id);
        if (!session || !entry) return;

        const table = /\bfrom\s+([\w."]+)/i.exec(entry.sql)?.[1]?.replaceAll('"', "") ?? "exported";
        const extension = { csv: "csv", json: "json", sql: "sql" }[format];
        const target = await chooseSaveFile({
            title: "Export result",
            defaultPath: `${table.split(".").pop()}.${extension}`,
            filters: [{ name: format.toUpperCase(), extensions: [extension] }],
        });
        if (!target) return;

        try {
            const rows = await backend.exportResult(session.id, entry.sql, format, target, table);
            log({ kind: "statement", source: tabTitle(path), text: `Exported ${plural(rows, "row")} to ${target}` });
        } catch (e) {
            setProblem(`Export failed: ${errorMessage(e)}`);
        }
    };

    actionsRef.current = {
        loadMore: (id) => void loadMore(id),
        cancel,
        close: (id) => {
            if (viewRef.current) hideResult(viewRef.current, id);
            dropResult(results, id);
            if (bottomResult.get()?.id === id) bottomResult.set(null);
        },
        popOut: (id) => bottomResult.set({ tab: path, store: results, id, actions: actionsProxy }),
        exportResult: (id, f) => void exportResult(id, f),
    };
    callbacksRef.current = {
        onChange: (text) => {
            textRef.current = text;
            onEdited();
            clearTimeout(saveTimer.current);
            saveTimer.current = setTimeout(() => void save(), AUTOSAVE_MS);
        },
        onRun: () => viewRef.current && void runStatements(statementsToRun(viewRef.current)),
        onRunAll: () => viewRef.current && void runStatements(allStatements(viewRef.current)),
        onFormat: () => format(),
        onCommit: () => void commit(),
        // Scripts save as you type; formatting then would move text under the cursor, so "format on
        // save" formats when the editor loses focus.
        onBlur: () => {
            if (settings.editor.format_on_save && textRef.current.trim()) format(true);
            void save();
        },
        mountResult,
    };

    // Stable objects that forward to the latest handlers, for widgets created in earlier renders.
    const actionsProxy = useMemo<ResultActions>(
        () => ({
            loadMore: (id) => actionsRef.current.loadMore(id),
            cancel: () => actionsRef.current.cancel(),
            close: (id) => actionsRef.current.close(id),
            popOut: (id) => actionsRef.current.popOut?.(id),
            exportResult: (id, f) => actionsRef.current.exportResult(id, f),
        }),
        [],
    );

    // Load the file and the script's settings, then create the editor. Once per path: a renamed
    // script is a new tab, and setting changes are applied by the effects below.
    // biome-ignore lint/correctness/useExhaustiveDependencies: load once per path
    useEffect(() => {
        let cancelled = false;
        Promise.all([readTabText(path), backend.scriptMeta(path)])
            .then(([text, meta]) => {
                if (cancelled || !hostRef.current) return;
                savedRef.current = text;
                textRef.current = text;
                setConnectionId(meta.connection_id);
                setSchema(meta.schema ?? "");
                setParams(meta.params);
                const engine = meta.connection_id
                    ? connections.index.connections.get(meta.connection_id)?.engine
                    : undefined;
                viewRef.current = createSqlEditor(
                    hostRef.current,
                    text,
                    engine === "sqlite" ? "sqlite" : "postgres",
                    settings.editor.autocomplete,
                    () => callbacksRef.current,
                );
            })
            .catch((e: unknown) => !cancelled && setLoadError(errorMessage(e)));

        return () => {
            cancelled = true;
            viewRef.current?.destroy();
            viewRef.current = null;
        };
    }, [path]);

    useEffect(() => {
        if (viewRef.current) setDialect(viewRef.current, dialect);
    }, [dialect]);

    useEffect(() => {
        if (viewRef.current) setAutocomplete(viewRef.current, settings.editor.autocomplete);
    }, [settings.editor.autocomplete]);

    useEffect(() => {
        if (active) viewRef.current?.focus();
    }, [active]);

    // Report what closing this tab involves.
    const sessionId = session?.id ?? null;
    const runtimeRef = useRef({ save, reloadFromDisk });
    runtimeRef.current = { save, reloadFromDisk };
    useEffect(() => {
        onRuntime({
            sessionId,
            inTransaction: txOpen,
            flush: () => runtimeRef.current.save(),
            reloadFromDisk: () => runtimeRef.current.reloadFromDisk(),
        });
    }, [sessionId, txOpen, onRuntime]);

    // Leaving the tab closes its session (the tab strip has already asked about open transactions).
    const sessionRef = useRef(session);
    sessionRef.current = session;
    useEffect(
        () => () => {
            void runtimeRef.current.save();
            if (sessionRef.current) void backend.disconnect(sessionRef.current.id).catch(() => {});
        },
        [],
    );

    const changeConnection = async (id: string | null) => {
        if (txOpen) return;
        if (session) {
            await backend.disconnect(session.id).catch(() => {});
            setSession(null);
            void connections.reload();
        }
        setConnectionId(id);
        setMode(null);
        setProblem(null);
        void backend.setScriptConnection(path, id).catch((e) => setProblem(errorMessage(e)));
    };

    const changeSchema = async (value: string) => {
        const next = value.trim() || null;
        void backend.setScriptSchema(path, next).catch(() => {});
        if (session && dialect === "postgres") {
            await backend.setSessionSchema(session.id, next).catch((e) => setProblem(errorMessage(e)));
        }
    };

    const changeMode = async (next: TransactionMode) => {
        setMode(next);
        if (session) await backend.setTransactionMode(session.id, next).catch((e) => setProblem(errorMessage(e)));
    };

    const connectionOptions = useMemo(() => {
        const list = [...connections.index.connections.values()].map((c) => {
            const folder = folderPath(connections.index, c.folder_id).join(" / ");
            return { value: c.id, label: folder ? `${folder} / ${c.name}` : c.name };
        });
        list.sort((a, b) => a.label.localeCompare(b.label));
        return [{ value: "", label: "No connection", muted: true }, ...list];
    }, [connections.index]);

    if (loadError) {
        return (
            <div className={styles.tab} hidden={!active}>
                <p className={controls.error}>
                    Could not open {path}: {loadError}
                </p>
            </div>
        );
    }

    return (
        <div className={styles.tab} hidden={!active}>
            <div className={styles.toolbar} role="toolbar" aria-label="Script">
                <button
                    type="button"
                    className={controls.primary}
                    disabled={running}
                    onClick={() => callbacksRef.current.onRun()}
                    {...tooltip("Run statement", { shortcut: "⌘⏎" })}
                >
                    <Play size={12} />
                    Run
                </button>
                <button
                    type="button"
                    className={controls.button}
                    disabled={running}
                    onClick={() => callbacksRef.current.onRunAll()}
                    {...tooltip("Run all statements", { shortcut: "⇧⌘⏎" })}
                >
                    <PlayCircle size={12} />
                    Run all
                </button>
                <button
                    type="button"
                    className={controls.button}
                    disabled
                    {...tooltip("Explain arrives in a later milestone")}
                >
                    <ScanSearch size={12} />
                    Explain
                </button>
                <button type="button" className={controls.button} disabled={!running} onClick={cancel}>
                    <Square size={11} />
                    Stop
                </button>

                <span className={styles.divider} />

                <span id={`${path}-connection-label`} className="visually-hidden">
                    Connection
                </span>
                <span className={styles.connection}>
                    <Select
                        value={connectionId ?? ""}
                        options={connectionOptions}
                        labelledBy={`${path}-connection-label`}
                        mono
                        onChange={(id) => void changeConnection(id || null)}
                    />
                </span>
                {connection && (
                    <span className={controls.badge} data-level={connection.access_level}>
                        {ACCESS_LABELS[connection.access_level]}
                    </span>
                )}
                {dialect === "postgres" && connection && (
                    <input
                        className={`${controls.input} ${styles.schema}`}
                        value={schema}
                        placeholder="schema"
                        aria-label="Schema (search_path)"
                        spellCheck={false}
                        onChange={(e) => setSchema(e.target.value)}
                        onBlur={(e) => void changeSchema(e.target.value)}
                        onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
                    />
                )}
                <Segmented
                    value={effectiveMode}
                    options={TX_MODES}
                    label="Transaction mode"
                    onChange={(m) => !txOpen && void changeMode(m)}
                />
                <button
                    type="button"
                    className={controls.ghost}
                    onClick={() => format()}
                    {...tooltip("Format", { shortcut: "⇧⌘F" })}
                >
                    <WandSparkles size={13} />
                    Format
                </button>

                <span className={styles.spacer} />
                {txOpen && (
                    <>
                        <span className={styles.txOpen}>Transaction open</span>
                        <button type="button" className={controls.button} onClick={() => void rollback()}>
                            Roll back
                        </button>
                        <button
                            type="button"
                            className={controls.primary}
                            onClick={() => void commit()}
                            {...tooltip("Commit", { shortcut: "⌘S" })}
                        >
                            Commit
                        </button>
                    </>
                )}
            </div>

            {problem && (
                <div className={styles.problem} role="alert">
                    <span>{problem}</span>
                    <button type="button" className={controls.ghost} onClick={() => setProblem(null)}>
                        Dismiss
                    </button>
                </div>
            )}

            <div ref={hostRef} className={styles.editor} />

            {connectFlow.prompt}

            {pending?.kind === "params" && (
                <ParamsDialog
                    keys={pending.keys}
                    remembered={params}
                    onClose={() => {
                        setPending(null);
                        pending.resolve(null);
                    }}
                    onRun={(values) => {
                        setPending(null);
                        pending.resolve(values);
                    }}
                />
            )}
            {pending?.kind === "confirm-commit" && (
                <Dialog
                    title="Commit these changes?"
                    width={560}
                    onClose={() => setPending(null)}
                    footer={
                        <>
                            <button type="button" className={controls.button} onClick={() => setPending(null)}>
                                Cancel
                            </button>
                            <button
                                type="button"
                                className={controls.button}
                                onClick={() => {
                                    setPending(null);
                                    void rollback();
                                }}
                            >
                                Roll back
                            </button>
                            <button
                                type="button"
                                className={controls.primary}
                                onClick={() => {
                                    setPending(null);
                                    void commit(true);
                                }}
                            >
                                Commit
                            </button>
                        </>
                    }
                >
                    <ul className={styles.txList}>
                        {pending.statements.map((s, i) => (
                            // biome-ignore lint/suspicious/noArrayIndexKey: the same statement can run twice
                            <li key={i}>
                                <code>{oneLine(s.sql)}</code>
                                <span className={styles.txRows}>
                                    {s.rows_affected == null ? "" : plural(s.rows_affected, "row")}
                                </span>
                            </li>
                        ))}
                        {pending.statements.length === 0 && <li>No changes were recorded in this transaction.</li>}
                    </ul>
                </Dialog>
            )}
            {pending?.kind === "conflict" && (
                <Dialog
                    title={`${path} changed on disk`}
                    onClose={() => setPending(null)}
                    footer={
                        <>
                            <button
                                type="button"
                                className={controls.button}
                                onClick={() => {
                                    applyDiskVersion(pending.disk);
                                    setPending(null);
                                }}
                            >
                                Use the file on disk
                            </button>
                            <button
                                type="button"
                                className={controls.primary}
                                onClick={() => {
                                    savedRef.current = pending.disk;
                                    setPending(null);
                                    void save();
                                }}
                            >
                                Keep my edits
                            </button>
                        </>
                    }
                >
                    <p className={styles.note}>
                        The file was changed outside DBrief while this tab had edits that weren't saved yet.
                    </p>
                </Dialog>
            )}
            {pending?.kind === "lost" && (
                <Dialog
                    title="Connection lost"
                    onClose={() => setPending(null)}
                    footer={
                        <button
                            type="button"
                            className={controls.primary}
                            onClick={() => {
                                setPending(null);
                                if (session) {
                                    void backend
                                        .acknowledgeLostTransaction(session.id)
                                        .then(() =>
                                            log({
                                                kind: "transaction",
                                                source: tabTitle(path),
                                                text: "Reconnected after a lost transaction",
                                            }),
                                        )
                                        .catch((e) => setProblem(errorMessage(e)));
                                }
                            }}
                        >
                            Reconnect
                        </button>
                    }
                >
                    <p className={styles.note}>{pending.message}</p>
                </Dialog>
            )}
        </div>
    );
}
