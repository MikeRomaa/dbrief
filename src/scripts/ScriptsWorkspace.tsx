import { Eye, FileCode, NotebookPen, Table2, X } from "lucide-react";
import { type Dispatch, useCallback, useEffect, useRef, useState } from "react";

import type { ConnectionsState } from "@/hooks/useConnections";
import { backend, errorMessage, type Settings } from "@/lib/backend";
import { setDisconnectGuard } from "@/lib/disconnect";
import { log } from "@/lib/log";
import { handleRovingKeyDown } from "@/lib/roving";
import type { Store } from "@/lib/store";
import { displayName, parseTableKey } from "@/lib/tableTabs";
import type { TabsAction, TabsState } from "@/lib/tabs";
import { ScriptTab, type TabRuntime } from "@/scripts/ScriptTab";
import { isScratchpad, tabTitle as scriptTitle } from "@/scripts/scratchpad";
import { TableTab } from "@/tables/TableTab";
import { Dialog } from "@/ui/Dialog";

import styles from "@/scripts/ScriptsWorkspace.module.css";
import controls from "@/ui/controls.module.css";

/** A tab's name: the script's file name, or the table's name. */
function tabTitle(key: string): string {
    const table = parseTableKey(key);
    return table ? table.name : scriptTitle(key);
}

/**
 * The editor area's tabs: scripts and tables. Every open tab stays mounted, so editors, results and sessions survive
 * switching. `changes` carries paths changed on disk, so open tabs can reload them.
 */
interface ScriptsWorkspaceProps {
    tabs: TabsState;
    dispatch: Dispatch<TabsAction>;
    connections: ConnectionsState;
    settings: Settings;
    changes: Store<string[]>;
    hidden: boolean;
}

export function ScriptsWorkspace({ tabs, dispatch, connections, settings, changes, hidden }: ScriptsWorkspaceProps) {
    const runtimes = useRef(new Map<string, TabRuntime>());
    const [closing, setClosing] = useState<{ path: string; runtime: TabRuntime } | null>(null);
    const [problem, setProblem] = useState<string | null>(null);
    const [disconnecting, setDisconnecting] = useState<{
        paths: string[];
        resolve: (ok: boolean) => void;
    } | null>(null);

    // Disconnecting a connection asks about tabs with uncommitted work on it.
    useEffect(
        () =>
            setDisconnectGuard(async (connectionId) => {
                const open = [...runtimes.current.entries()]
                    .filter(([, r]) => r.connectionId === connectionId && r.inTransaction && r.sessionId)
                    .map(([path]) => path);
                if (open.length === 0) return true;
                return new Promise<boolean>((resolve) => setDisconnecting({ paths: open, resolve }));
            }),
        [],
    );

    const endAll = async (how: "commit" | "rollback" | "cancel") => {
        if (!disconnecting) return;
        const { paths, resolve } = disconnecting;
        setDisconnecting(null);
        if (how === "cancel") return resolve(false);
        try {
            for (const path of paths) {
                const sessionId = runtimes.current.get(path)?.sessionId;
                if (!sessionId) continue;
                await (how === "commit" ? backend.commit(sessionId) : backend.rollback(sessionId));
                log({ kind: "transaction", source: tabTitle(path), text: how === "commit" ? "COMMIT" : "ROLLBACK" });
            }
            resolve(true);
        } catch (e) {
            setProblem(errorMessage(e));
            resolve(false);
        }
    };

    // One stable callback per path, so tabs don't re-report on every render.
    const reporters = useRef(new Map<string, (runtime: TabRuntime) => void>());
    const reporterFor = useCallback((path: string) => {
        let reporter = reporters.current.get(path);
        if (!reporter) {
            reporter = (runtime) => runtimes.current.set(path, runtime);
            reporters.current.set(path, reporter);
        }
        return reporter;
    }, []);

    useEffect(
        () =>
            changes.subscribe(() => {
                for (const path of changes.get()) {
                    void runtimes.current.get(path)?.reloadFromDisk();
                }
            }),
        [changes],
    );

    const finishClose = async (path: string) => {
        await runtimes.current.get(path)?.flush();
        runtimes.current.delete(path);
        reporters.current.delete(path);
        dispatch({ type: "close", path });
    };

    const close = (path: string) => {
        const runtime = runtimes.current.get(path);
        if (runtime?.inTransaction && runtime.sessionId) {
            setClosing({ path, runtime });
        } else {
            void finishClose(path);
        }
    };

    const endAndClose = async (how: "commit" | "rollback") => {
        if (!closing) return;
        const { path, runtime } = closing;
        setClosing(null);
        try {
            if (runtime.sessionId) {
                await (how === "commit" ? backend.commit(runtime.sessionId) : backend.rollback(runtime.sessionId));
                log({ kind: "transaction", source: tabTitle(path), text: how === "commit" ? "COMMIT" : "ROLLBACK" });
            }
            await finishClose(path);
        } catch (e) {
            setProblem(errorMessage(e));
        }
    };

    // ⌘W closes the active tab.
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "w" && !hidden && tabs.active) {
                e.preventDefault();
                close(tabs.active);
            }
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    });

    if (tabs.tabs.length === 0) {
        return (
            <div className={styles.empty} hidden={hidden}>
                <p>No open tabs</p>
                <p className={styles.hint}>Open a script from the Scripts panel, or a table from the Explorer.</p>
            </div>
        );
    }

    return (
        <div className={styles.workspace} hidden={hidden}>
            <div
                role="tablist"
                aria-label="Open tabs"
                className={styles.strip}
                onKeyDown={(e) => {
                    const el = handleRovingKeyDown(e, '[role="tab"]', "horizontal");
                    if (el?.dataset.path) dispatch({ type: "activate", path: el.dataset.path });
                }}
            >
                {tabs.tabs.map((tab) => {
                    const selected = tab.path === tabs.active;
                    const table = parseTableKey(tab.path);
                    const connection = table ? connections.index.connections.get(table.connectionId) : undefined;
                    const title = table
                        ? `${connection?.name ?? "Removed connection"} · ${table.schema}.${table.name}`
                        : isScratchpad(tab.path)
                          ? "Scratchpad (kept in DBrief, not a file)"
                          : tab.path;
                    const Icon = table
                        ? table.kind === "table"
                            ? Table2
                            : Eye
                        : isScratchpad(tab.path)
                          ? NotebookPen
                          : FileCode;
                    return (
                        <div key={tab.path} className={styles.tab} data-selected={selected || undefined}>
                            <button
                                type="button"
                                role="tab"
                                data-path={tab.path}
                                aria-selected={selected}
                                tabIndex={selected ? 0 : -1}
                                className={styles.tabButton}
                                data-preview={tab.preview || undefined}
                                title={title}
                                onClick={() => dispatch({ type: "activate", path: tab.path })}
                                onDoubleClick={() => dispatch({ type: "pin", path: tab.path })}
                                onAuxClick={(e) => e.button === 1 && close(tab.path)}
                            >
                                <Icon size={13} />
                                <span className={styles.tabName}>
                                    {table ? displayName(table.schema, table.name) : tabTitle(tab.path)}
                                </span>
                            </button>
                            <button
                                type="button"
                                className={styles.close}
                                aria-label={`Close ${tabTitle(tab.path)}`}
                                tabIndex={-1}
                                onClick={() => close(tab.path)}
                            >
                                <X size={12} />
                            </button>
                        </div>
                    );
                })}
            </div>

            {problem && (
                <p className={controls.error} role="alert">
                    {problem}
                </p>
            )}

            {tabs.tabs.map((tab) => {
                const table = parseTableKey(tab.path);
                const props = {
                    active: tab.path === tabs.active,
                    connections,
                    settings,
                    onEdited: () => tab.preview && dispatch({ type: "pin", path: tab.path }),
                    onRuntime: reporterFor(tab.path),
                };
                return table ? (
                    <TableTab key={tab.path} table={table} {...props} />
                ) : (
                    <ScriptTab key={tab.path} path={tab.path} {...props} />
                );
            })}

            {disconnecting && (
                <Dialog
                    title="Disconnect with uncommitted changes?"
                    onClose={() => void endAll("cancel")}
                    footer={
                        <>
                            <button type="button" className={controls.button} onClick={() => void endAll("cancel")}>
                                Cancel
                            </button>
                            <button type="button" className={controls.button} onClick={() => void endAll("rollback")}>
                                Roll back
                            </button>
                            <button type="button" className={controls.primary} onClick={() => void endAll("commit")}>
                                Commit
                            </button>
                        </>
                    }
                >
                    <p className={styles.hint}>
                        {disconnecting.paths.map(tabTitle).join(", ")}{" "}
                        {disconnecting.paths.length === 1 ? "has a transaction" : "have transactions"} with changes that
                        aren't committed yet.
                    </p>
                </Dialog>
            )}

            {closing && (
                <Dialog
                    title={`Close ${tabTitle(closing.path)}?`}
                    onClose={() => setClosing(null)}
                    footer={
                        <>
                            <button type="button" className={controls.button} onClick={() => setClosing(null)}>
                                Cancel
                            </button>
                            <button
                                type="button"
                                className={controls.button}
                                onClick={() => void endAndClose("rollback")}
                            >
                                Roll back
                            </button>
                            <button
                                type="button"
                                className={controls.primary}
                                onClick={() => void endAndClose("commit")}
                            >
                                Commit
                            </button>
                        </>
                    }
                >
                    <p className={styles.hint}>This tab has a transaction with changes that aren't committed yet.</p>
                </Dialog>
            )}
        </div>
    );
}
