import { RotateCcw } from "lucide-react";

import { useStore } from "@/hooks/useStore";
import { plural } from "@/lib/connections/connectionFormat";
import { summary } from "@/lib/grid/staging";
import { stagedPanel } from "@/lib/shell/staged";

import styles from "@/components/shell/StagedPanel.module.css";
import controls from "@/components/ui/controls.module.css";

const KIND_LABELS = { update: "Edit", insert: "Insert", delete: "Delete" } as const;

/**
 * The bottom panel's Staged changes tab: the active table tab's changes in the order they run
 * (deletes, updates, inserts), each with its SQL and a Revert button.
 */
export function StagedPanel() {
    const panel = useStore(stagedPanel);
    if (!panel) return <p className={styles.empty}>No staged changes in the active tab.</p>;

    return (
        <div className={styles.panel}>
            <div className={styles.header}>
                <span className={styles.title}>
                    {plural(panel.counts.total, "staged change")} · {panel.source}
                </span>
                <span className={styles.summary}>{summary(panel.counts)}</span>
            </div>
            {panel.error && (
                <p className={controls.error} role="alert">
                    {panel.error}
                </p>
            )}
            <ol className={styles.entries} aria-label="Staged changes">
                {panel.entries.map((entry) => (
                    <li key={entry.change} className={styles.entry} data-kind={entry.kind}>
                        <span className={styles.kind}>{KIND_LABELS[entry.kind]}</span>
                        <span className={styles.row}>row {entry.row}</span>
                        <code className={styles.sql}>{entry.sql ?? "…"}</code>
                        <button
                            type="button"
                            className={controls.iconButton}
                            aria-label={`Revert ${KIND_LABELS[entry.kind].toLowerCase()} of row ${entry.row}`}
                            title="Revert"
                            onClick={() => panel.revert(entry.change)}
                        >
                            <RotateCcw size={12} />
                        </button>
                    </li>
                ))}
            </ol>
        </div>
    );
}
