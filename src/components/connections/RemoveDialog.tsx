import { useEffect, useState } from "react";

import { Dialog } from "@/components/ui/Dialog";
import { plural } from "@/lib/connections/connectionFormat";
import { backend, errorMessage } from "@/lib/ipc/backend";
import type { DeleteCounts, ItemRef } from "@/lib/ipc/bindings";

import styles from "@/components/connections/ConnectionsView.module.css";
import controls from "@/components/ui/controls.module.css";

interface RemoveDialogProps {
    item: ItemRef;
    name: string;
    onConfirm: () => Promise<void>;
    onClose: () => void;
}

/** Confirms removing a connection, or a folder with everything in it. There is no undo. */
export function RemoveDialog({ item, name, onConfirm, onClose }: RemoveDialogProps) {
    const [counts, setCounts] = useState<DeleteCounts | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [removing, setRemoving] = useState(false);
    const { kind, id } = item;

    useEffect(() => {
        backend
            .deleteCounts({ kind, id })
            .then(setCounts)
            .catch((e: unknown) => setError(errorMessage(e)));
    }, [kind, id]);

    const remove = async () => {
        setRemoving(true);
        await onConfirm();
        onClose();
    };

    const title = kind === "folder" ? `Delete folder “${name}”?` : `Remove “${name}”?`;

    return (
        <Dialog
            title={title}
            onClose={onClose}
            footer={
                <>
                    <button type="button" className={controls.button} onClick={onClose}>
                        Cancel
                    </button>
                    <button
                        type="button"
                        className={controls.danger}
                        disabled={!counts || removing}
                        onClick={() => void remove()}
                    >
                        {kind === "folder" ? "Delete folder" : "Remove connection"}
                    </button>
                </>
            }
        >
            {error && (
                <p className={controls.error} role="alert">
                    {error}
                </p>
            )}
            {counts && (
                <>
                    <p className={styles.dialogText}>This deletes:</p>
                    <ul className={styles.deleteList}>
                        {kind === "folder" && <li>{plural(counts.folders, "folder")}, including subfolders</li>}
                        <li>
                            {plural(counts.connections, "connection")} and {counts.connections === 1 ? "its" : "their"}{" "}
                            saved passwords
                        </li>
                    </ul>
                    <p className={styles.dialogText}>Open sessions are closed. There is no undo.</p>
                </>
            )}
        </Dialog>
    );
}
