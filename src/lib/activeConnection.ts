import { Store } from "@/lib/store";

/**
 * The active connection: the active tab's connection, or the most recently connected one. The
 * Explorer shows it by default; the status bar shows its name, access level and version.
 */
export const activeConnection = new Store<string | null>(null);

/**
 * The connection the Explorer shows. It follows the active connection until the user picks another
 * in the Explorer.
 */
export const explorerConnection = new Store<string | null>(null);

activeConnection.subscribe(() => {
    const id = activeConnection.get();
    if (id) explorerConnection.set(id);
});
