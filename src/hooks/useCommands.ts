import { createContext, useContext } from "react";

import type { CommandRegistry } from "@/lib/shell/commands";

export const CommandsContext = createContext<CommandRegistry | null>(null);

export function useCommands(): CommandRegistry {
    const registry = useContext(CommandsContext);
    if (!registry) {
        throw new Error("useCommands must be used inside CommandsContext");
    }

    return registry;
}
