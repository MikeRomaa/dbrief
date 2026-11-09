import { Store } from "@/lib/util/store";

/**
 * The active connection: the active tab's connection, or the most recently connected one. The
 * status bar shows its name, access level and version; the Explorer marks it among the open ones.
 */
export const activeConnection = new Store<string | null>(null);
