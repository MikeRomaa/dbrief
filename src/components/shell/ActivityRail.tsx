import { Database, FileCode, History, Network, Settings2, Table } from "lucide-react";
import type { ComponentType } from "react";

import { useCommands } from "@/hooks/useCommands";
import { type LayoutState, RAIL_ITEMS, type RailItem } from "@/lib/shell/layout";
import { commandHints, RAIL_COMMANDS } from "@/lib/shell/shellCommands";
import { handleRovingKeyDown } from "@/lib/util/roving";

import styles from "@/components/shell/ActivityRail.module.css";

const ICONS: Record<RailItem, ComponentType<{ size?: number }>> = {
    connections: Database,
    explorer: Table,
    scripts: FileCode,
    history: History,
    diagrams: Network,
    settings: Settings2,
};

export const railTabId = (item: RailItem) => `rail-tab-${item}`;

interface ActivityRailProps {
    layout: LayoutState;
}

export function ActivityRail({ layout }: ActivityRailProps) {
    const commands = useCommands();
    const main = RAIL_ITEMS.filter((i) => i !== "settings");

    const renderItem = (item: RailItem) => {
        const Icon = ICONS[item];
        const meta = RAIL_COMMANDS[item];
        const selected = layout.activeRailItem === item;

        return (
            <button
                key={item}
                id={railTabId(item)}
                type="button"
                role="tab"
                className={styles.item}
                aria-label={meta.label}
                aria-selected={selected}
                aria-controls="side-panel"
                tabIndex={selected ? 0 : -1}
                data-expanded={selected && layout.sidePanelVisible}
                onClick={() => commands.run(meta.id)}
                {...commandHints(meta, "right")}
            >
                <Icon size={17} />
            </button>
        );
    };

    return (
        <nav className={styles.rail} aria-label="Activity rail">
            <div
                role="tablist"
                aria-label="Views"
                aria-orientation="vertical"
                className={styles.list}
                onKeyDown={(e) => handleRovingKeyDown(e, '[role="tab"]', "vertical")}
            >
                {main.map(renderItem)}
                <div className={styles.spacer} />
                {renderItem("settings")}
            </div>
        </nav>
    );
}
