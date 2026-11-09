import { ChevronDown, ChevronUp } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";

import { BottomResults } from "@/components/scripts/BottomResults";
import { railTabId } from "@/components/shell/ActivityRail";
import { InspectorPanel } from "@/components/shell/InspectorPanel";
import { LogPanel } from "@/components/shell/LogPanel";
import { StagedPanel } from "@/components/shell/StagedPanel";
import { useCommands } from "@/hooks/useCommands";
import type { Settings } from "@/lib/ipc/backend";
import type { LayoutState, RailItem } from "@/lib/shell/layout";
import { commandHints, RAIL_COMMANDS, SHELL_COMMANDS } from "@/lib/shell/shellCommands";
import { panelRequest } from "@/lib/shell/staged";
import { handleRovingKeyDown } from "@/lib/util/roving";

import styles from "@/components/shell/Panels.module.css";

const SIDE_PANEL_HINTS: Record<Exclude<RailItem, "settings">, string> = {
    connections: "Saved connections will appear here.",
    explorer: "Schemas and tables of the active connection will appear here.",
    scripts: "SQL scripts from your scripts folder will appear here.",
    history: "Queries you run will appear here.",
    diagrams: "Saved diagrams will appear here.",
};

/** The side panel for the rail item; `children`, when given, replace the placeholder content. */
export function SidePanel({ item, width, children }: { item: RailItem; width: number; children?: ReactNode }) {
    const title = RAIL_COMMANDS[item].label;
    return (
        <section
            id="side-panel"
            role="tabpanel"
            aria-labelledby={railTabId(item)}
            className={styles.sidePanel}
            style={{ width }}
        >
            {children ?? <h2 className={styles.panelHeader}>{title}</h2>}
            {children ? null : item === "settings" ? (
                <ul className={styles.sectionList} aria-label="Settings sections">
                    <li>
                        <a className={styles.sectionLink} href="#settings-appearance">
                            Appearance
                        </a>
                    </li>
                    <li>
                        <a className={styles.sectionLink} href="#settings-editor">
                            Editor
                        </a>
                    </li>
                    <li>
                        <a className={styles.sectionLink} href="#settings-data-grid">
                            Data grid
                        </a>
                    </li>
                </ul>
            ) : (
                <p className={styles.placeholder}>{SIDE_PANEL_HINTS[item]}</p>
            )}
        </section>
    );
}

const BOTTOM_TABS = ["Results", "Staged changes", "Log", "History"] as const;

export function BottomPanel({ layout, height }: { layout: LayoutState; height: number }) {
    const commands = useCommands();
    const [active, setActive] = useState<(typeof BOTTOM_TABS)[number]>("Results");
    const collapsed = layout.bottomPanelCollapsed;
    const tabId = (t: string) => `bottom-tab-${t.replace(/\s+/g, "-").toLowerCase()}`;

    // Review SQL (and the status bar's staged count) open the Staged changes tab.
    useEffect(
        () =>
            panelRequest.subscribe(() => {
                if (panelRequest.get()?.panel !== "staged") return;
                setActive("Staged changes");
                if (layout.bottomPanelCollapsed) commands.run(SHELL_COMMANDS.toggleBottomPanel.id);
            }),
        [layout.bottomPanelCollapsed, commands],
    );

    return (
        <section id="bottom-panel" aria-label="Bottom panel" className={styles.bottomPanel} style={{ height }}>
            <div className={styles.bottomHeader}>
                <div
                    role="tablist"
                    aria-label="Bottom panel views"
                    className={styles.bottomTabs}
                    onKeyDown={(e) => {
                        const el = handleRovingKeyDown(e, '[role="tab"]', "horizontal");
                        const tab = BOTTOM_TABS.find((t) => tabId(t) === el?.id);
                        if (tab) {
                            setActive(tab);
                        }
                    }}
                >
                    {BOTTOM_TABS.map((t) => (
                        <button
                            key={t}
                            id={tabId(t)}
                            type="button"
                            role="tab"
                            className={styles.bottomTab}
                            aria-selected={active === t}
                            aria-controls="bottom-panel-content"
                            tabIndex={active === t ? 0 : -1}
                            onClick={() => {
                                setActive(t);

                                if (collapsed) {
                                    commands.run(SHELL_COMMANDS.toggleBottomPanel.id);
                                }
                            }}
                        >
                            {t}
                        </button>
                    ))}
                </div>
                <button
                    type="button"
                    className={styles.iconButton}
                    aria-label={collapsed ? "Expand bottom panel" : "Collapse bottom panel"}
                    aria-expanded={!collapsed}
                    aria-controls="bottom-panel-content"
                    onClick={() => commands.run(SHELL_COMMANDS.toggleBottomPanel.id)}
                    {...commandHints(SHELL_COMMANDS.toggleBottomPanel)}
                >
                    {collapsed ? <ChevronUp /> : <ChevronDown />}
                </button>
            </div>
            <div
                id="bottom-panel-content"
                role="tabpanel"
                aria-labelledby={tabId(active)}
                className={styles.bottomContent}
                hidden={collapsed}
            >
                {active === "Results" ? (
                    <BottomResults />
                ) : active === "Log" ? (
                    <LogPanel />
                ) : active === "Staged changes" ? (
                    <StagedPanel />
                ) : (
                    <p className={styles.placeholder}>Nothing here yet.</p>
                )}
            </div>
        </section>
    );
}

export function Inspector({ settings, width }: { settings: Settings | null; width: number }) {
    return (
        <aside id="inspector" aria-label="Inspector" className={styles.inspector} style={{ width }}>
            <h2 className={styles.panelHeader}>Inspector</h2>
            <InspectorPanel settings={settings} />
        </aside>
    );
}
