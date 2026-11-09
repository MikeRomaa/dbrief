import type { StagedCounts } from "@/lib/grid/staging";
import { Store } from "@/lib/util/store";

/**
 * The active table tab's staged changes, for the bottom panel's Staged changes tab and the status
 * bar. `statements` is the SQL that would run, one per change (`null` while it is worked out);
 * `revert` takes back one change by its index.
 */
export interface StagedEntry {
    change: number;
    row: string;
    kind: "update" | "insert" | "delete";
    sql: string | null;
}

export interface StagedPanel {
    source: string;
    counts: StagedCounts;
    entries: StagedEntry[];
    error: string | null;
    revert: (change: number) => void;
}

export const stagedPanel = new Store<StagedPanel | null>(null);

/** Asks the shell to show a panel: the inspector, or the bottom panel's Staged changes tab. */
export const panelRequest = new Store<{ panel: "inspector" | "staged"; at: number } | null>(null);

export function showPanel(panel: "inspector" | "staged") {
    panelRequest.set({ panel, at: Date.now() });
}
