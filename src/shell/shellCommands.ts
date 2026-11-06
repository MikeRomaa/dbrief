import { platform } from "@tauri-apps/plugin-os";
import { createContext, useContext } from "react";

import { ariaKeyShortcut, type CommandRegistry, formatShortcut, type Shortcut } from "@/lib/commands";
import type { RailItem } from "@/lib/layout";
import type { Placement } from "@/lib/tooltip";
import { tooltip } from "@/shell/TooltipLayer";

export interface CommandMeta {
    id: string;
    label: string;
    shortcut?: Shortcut;
}

/** Shell commands and their default shortcuts. Handlers are registered in `Shell`. */
export const SHELL_COMMANDS = {
    toggleSidePanel: { id: "view.toggleSidePanel", label: "Toggle side panel", shortcut: "Mod+B" },
    toggleBottomPanel: {
        id: "view.toggleBottomPanel",
        label: "Toggle bottom panel",
        shortcut: "Mod+J",
    },
    toggleInspector: {
        id: "view.toggleInspector",
        label: "Toggle inspector",
        shortcut: "Mod+Alt+B",
    },
    search: { id: "search.open", label: "Search", shortcut: "Mod+P" },
} satisfies Record<string, CommandMeta>;

export const RAIL_COMMANDS: Record<RailItem, CommandMeta> = {
    connections: { id: "rail.connections", label: "Connections", shortcut: "Mod+1" },
    explorer: { id: "rail.explorer", label: "Explorer", shortcut: "Mod+2" },
    scripts: { id: "rail.scripts", label: "Scripts", shortcut: "Mod+3" },
    history: { id: "rail.history", label: "History", shortcut: "Mod+4" },
    diagrams: { id: "rail.diagrams", label: "Diagrams", shortcut: "Mod+5" },
    settings: { id: "rail.settings", label: "Settings", shortcut: "Mod+," },
};

/** Tooltip and `aria-keyshortcuts` attributes for a control that runs a command. */
export function commandHints(meta: CommandMeta, placement?: Placement): Record<string, string> {
    const shortcut = meta.shortcut ? formatShortcut(meta.shortcut, platform()) : undefined;
    const attrs = tooltip(meta.label, { shortcut, placement });

    if (meta.shortcut) {
        attrs["aria-keyshortcuts"] = ariaKeyShortcut(meta.shortcut, platform());
    }

    return attrs;
}

export const CommandsContext = createContext<CommandRegistry | null>(null);

export function useCommands(): CommandRegistry {
    const registry = useContext(CommandsContext);
    if (!registry) {
        throw new Error("useCommands must be used inside CommandsContext");
    }

    return registry;
}
