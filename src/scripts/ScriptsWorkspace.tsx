import { FileCode, NotebookPen, X } from "lucide-react";
import { type Dispatch, useCallback, useEffect, useRef, useState } from "react";

import type { ConnectionsState } from "@/hooks/useConnections";
import { backend, errorMessage, type Settings } from "@/lib/backend";
import { log } from "@/lib/log";
import { handleRovingKeyDown } from "@/lib/roving";
import type { Store } from "@/lib/store";
import type { TabsAction, TabsState } from "@/lib/tabs";
import { ScriptTab, type TabRuntime } from "@/scripts/ScriptTab";
import { isScratchpad, tabTitle } from "@/scripts/scratchpad";
import { Dialog } from "@/ui/Dialog";

import styles from "@/scripts/ScriptsWorkspace.module.css";
import controls from "@/ui/controls.module.css";

/**
 * The editor area's tabs. Every open tab stays mounted, so editors, results and sessions survive
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
                <p className={styles.hint}>Open a script from the Scripts panel.</p>
            </div>
        );
    }

    return (
        <div className={styles.workspace} hidden={hidden}>
            <div
                role="tablist"
                aria-label="Open scripts"
                className={styles.strip}
                onKeyDown={(e) => {
                    const el = handleRovingKeyDown(e, '[role="tab"]', "horizontal");
                    if (el?.dataset.path) dispatch({ type: "activate", path: el.dataset.path });
                }}
            >
                {tabs.tabs.map((tab) => {
                    const selected = tab.path === tabs.active;
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
                                title={isScratchpad(tab.path) ? "Scratchpad (kept in DBrief, not a file)" : tab.path}
                                onClick={() => dispatch({ type: "activate", path: tab.path })}
                                onDoubleClick={() => dispatch({ type: "pin", path: tab.path })}
                                onAuxClick={(e) => e.button === 1 && close(tab.path)}
                            >
                                {isScratchpad(tab.path) ? <NotebookPen size={13} /> : <FileCode size={13} />}
                                <span className={styles.tabName}>{tabTitle(tab.path)}</span>
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

            {tabs.tabs.map((tab) => (
                <ScriptTab
                    key={tab.path}
                    path={tab.path}
                    active={tab.path === tabs.active}
                    connections={connections}
                    settings={settings}
                    onEdited={() => tab.preview && dispatch({ type: "pin", path: tab.path })}
                    onRuntime={reporterFor(tab.path)}
                />
            ))}

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
