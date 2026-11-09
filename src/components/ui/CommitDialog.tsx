import { Dialog } from "@/components/ui/Dialog";
import { plural } from "@/lib/connections/connectionFormat";
import type { TransactionStatement } from "@/lib/ipc/bindings";

import styles from "@/components/ui/CommitDialog.module.css";
import controls from "@/components/ui/controls.module.css";

const oneLine = (sql: string) => sql.replace(/\s+/g, " ").trim();

/** Confirm before commit: the transaction's statements with their rows affected. */
export function CommitDialog({
    statements,
    onCommit,
    onRollback,
    onCancel,
}: {
    statements: TransactionStatement[];
    onCommit: () => void;
    onRollback: () => void;
    onCancel: () => void;
}) {
    return (
        <Dialog
            title="Commit these changes?"
            width={560}
            onClose={onCancel}
            footer={
                <>
                    <button type="button" className={controls.button} onClick={onCancel}>
                        Cancel
                    </button>
                    <button type="button" className={controls.button} onClick={onRollback}>
                        Roll back
                    </button>
                    <button type="button" className={controls.primary} onClick={onCommit}>
                        Commit
                    </button>
                </>
            }
        >
            <ul className={styles.list}>
                {statements.map((s, i) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: the same statement can run twice
                    <li key={i}>
                        <code>{oneLine(s.sql)}</code>
                        <span className={styles.rows}>
                            {s.rows_affected == null ? "" : plural(s.rows_affected, "row")}
                        </span>
                    </li>
                ))}
                {statements.length === 0 && <li>No changes were recorded in this transaction.</li>}
            </ul>
        </Dialog>
    );
}
