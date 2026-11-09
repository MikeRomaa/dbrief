import { PanelBottom, PanelLeft, PanelRight, TriangleAlert } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";

import { useCommands } from "@/hooks/useCommands";
import { ACCESS_LABELS } from "@/lib/connections/connectionFormat";
import type { AccessLevel } from "@/lib/ipc/bindings";
import type { LayoutState } from "@/lib/shell/layout";
import { type CommandMeta, commandHints, SHELL_COMMANDS } from "@/lib/shell/shellCommands";
import { showPanel } from "@/lib/shell/staged";
import { tooltip } from "@/lib/shell/tooltip";

import styles from "@/components/shell/StatusBar.module.css";
import controls from "@/components/ui/controls.module.css";

/** The active connection as the status bar shows it. */
export interface StatusConnection {
    name: string;
    accessLevel: AccessLevel;
    serverVersion: string | null;
    connected: boolean;
}

interface StatusBarProps {
    layout: LayoutState;
    warnings: string[];
    summary?: string[];
    connection?: StatusConnection | null;
    tint?: string;
    /** Staged grid changes in the active tab. */
    staged?: number;
}

function PanelToggle({
    meta,
    label,
    pressed,
    controls,
    children,
}: {
    meta: CommandMeta;
    label: string;
    pressed: boolean;
    controls: string;
    children: ReactNode;
}) {
    const commands = useCommands();
    return (
        <button
            type="button"
            className={styles.toggle}
            aria-label={label}
            aria-pressed={pressed}
            aria-controls={controls}
            onClick={() => commands.run(meta.id)}
            {...commandHints(meta, "top")}
        >
            {children}
        </button>
    );
}

/** Status bar. Panel toggles sit at the edge nearest the panel they control. */
export function StatusBar({ layout, warnings, summary, connection, tint, staged = 0 }: StatusBarProps) {
    return (
        <footer
            className={styles.statusBar}
            data-tinted={tint ? true : undefined}
            style={tint ? ({ "--bar-tint": tint } as CSSProperties) : undefined}
        >
            <PanelToggle
                meta={SHELL_COMMANDS.toggleSidePanel}
                label="Side panel"
                pressed={layout.sidePanelVisible}
                controls="side-panel"
            >
                <PanelLeft size={14} />
            </PanelToggle>
            {summary ? (
                summary.map((item) => (
                    <span key={item} className={styles.item}>
                        {item}
                    </span>
                ))
            ) : connection ? (
                <span className={styles.connection}>
                    <span
                        role="img"
                        className={connection.connected ? styles.connected : styles.disconnected}
                        aria-label={connection.connected ? "Connected" : "Not connected"}
                    />
                    <span className={styles.item}>{connection.name}</span>
                    <span className={controls.badge} data-level={connection.accessLevel}>
                        {ACCESS_LABELS[connection.accessLevel]}
                    </span>
                    {connection.serverVersion && <span className={styles.item}>{connection.serverVersion}</span>}
                </span>
            ) : (
                <span className={styles.item}>No connection</span>
            )}
            <span className={styles.spacer} />
            <span role="status" className={styles.status}>
                {warnings.map((w) => (
                    <span key={w} className={styles.warning} {...tooltip(w, { placement: "top" })}>
                        <TriangleAlert size={12} />
                        <span className={styles.warningText}>{w}</span>
                    </span>
                ))}
            </span>
            {staged > 0 && (
                <button
                    type="button"
                    className={styles.staged}
                    onClick={() => showPanel("staged")}
                    {...tooltip("Show the staged changes", { placement: "top" })}
                >
                    {staged} staged
                </button>
            )}
            <span className={styles.item}>UTF-8</span>
            <span className={styles.toggles}>
                <PanelToggle
                    meta={SHELL_COMMANDS.toggleBottomPanel}
                    label="Bottom panel"
                    pressed={!layout.bottomPanelCollapsed}
                    controls="bottom-panel"
                >
                    <PanelBottom size={14} />
                </PanelToggle>
                <PanelToggle
                    meta={SHELL_COMMANDS.toggleInspector}
                    label="Inspector"
                    pressed={layout.inspectorVisible}
                    controls="inspector"
                >
                    <PanelRight size={14} />
                </PanelToggle>
            </span>
        </footer>
    );
}
