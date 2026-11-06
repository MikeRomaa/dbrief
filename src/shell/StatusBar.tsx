import { PanelBottom, PanelLeft, PanelRight, TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";

import type { LayoutState } from "@/lib/layout";
import { type CommandMeta, commandHints, SHELL_COMMANDS, useCommands } from "@/shell/shellCommands";
import { tooltip } from "@/shell/TooltipLayer";

import styles from "@/shell/StatusBar.module.css";

interface StatusBarProps {
    layout: LayoutState;
    warnings: string[];
    summary?: string[];
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
export function StatusBar({ layout, warnings, summary }: StatusBarProps) {
    return (
        <footer className={styles.statusBar}>
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
