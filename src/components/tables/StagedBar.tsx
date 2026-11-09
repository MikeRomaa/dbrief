import { ScrollText } from "lucide-react";

import { plural } from "@/lib/connections/connectionFormat";
import { type StagedCounts, summary } from "@/lib/grid/staging";
import type { TransactionMode } from "@/lib/ipc/bindings";
import { showPanel } from "@/lib/shell/staged";
import { tooltip } from "@/lib/shell/tooltip";

import styles from "@/components/tables/TableTab.module.css";
import controls from "@/components/ui/controls.module.css";

/**
 * The bar under the grid while changes are staged: counts, Review SQL, Revert all, and Commit (auto
 * mode) or Apply (manual mode, which runs them inside the open transaction).
 */
export function StagedBar({
    counts,
    mode,
    busy,
    onRevertAll,
    onApply,
}: {
    counts: StagedCounts;
    mode: TransactionMode;
    busy: boolean;
    onRevertAll: () => void;
    onApply: () => void;
}) {
    const action = mode === "manual" ? "Apply" : "Commit";
    return (
        <section className={styles.stagedBar} aria-label="Staged changes">
            <span className={styles.stagedCount} aria-live="polite">
                <span className={styles.stagedDot} aria-hidden />
                {plural(counts.total, "staged change")}
            </span>
            <span className={styles.stagedSummary}>{summary(counts)}</span>
            <button type="button" className={controls.ghost} onClick={() => showPanel("staged")}>
                <ScrollText size={13} />
                Review SQL
            </button>
            <span className={styles.spacer} />
            <span className={styles.stagedSummary}>Tx: {mode === "manual" ? "Manual" : "Auto"}</span>
            <button type="button" className={controls.ghost} disabled={busy} onClick={onRevertAll}>
                Revert all
            </button>
            <button
                type="button"
                className={controls.primary}
                disabled={busy}
                onClick={onApply}
                {...tooltip(
                    mode === "manual"
                        ? "Run the changes in the open transaction; Commit ends it"
                        : "Run the changes in one transaction and commit",
                    { shortcut: "⌘S" },
                )}
            >
                {busy ? `${action}ing…` : action}
                <span className={styles.shortcut}>⌘S</span>
            </button>
        </section>
    );
}
