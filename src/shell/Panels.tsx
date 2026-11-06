import { ChevronDown, ChevronUp } from "lucide-react";
import { type ReactNode, useState } from "react";

import type { Settings } from "@/lib/backend";
import type { LayoutState, RailItem } from "@/lib/layout";
import { handleRovingKeyDown } from "@/lib/roving";
import { BottomResults } from "@/scripts/BottomResults";
import { railTabId } from "@/shell/ActivityRail";
import { InspectorPanel } from "@/shell/InspectorPanel";
import { LogPanel } from "@/shell/LogPanel";
import { commandHints, RAIL_COMMANDS, SHELL_COMMANDS, useCommands } from "@/shell/shellCommands";

import styles from "@/shell/Panels.module.css";

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
                ) : (
                    <p className={styles.placeholder}>Nothing here yet.</p>
                )}
            </div>
        </section>
    );
}

export function Inspector({ settings }: { settings: Settings | null }) {
    return (
        <aside id="inspector" aria-label="Inspector" className={styles.inspector}>
            <h2 className={styles.panelHeader}>Inspector</h2>
            <InspectorPanel settings={settings} />
        </aside>
    );
}
