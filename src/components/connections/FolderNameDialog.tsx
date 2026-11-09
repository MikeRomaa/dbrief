import { useState } from "react";

import { Dialog } from "@/components/ui/Dialog";

import styles from "@/components/connections/ConnectionsView.module.css";
import controls from "@/components/ui/controls.module.css";

interface FolderNameDialogProps {
    title: string;
    action: string;
    initial?: string;
    onSave: (name: string) => Promise<void>;
    onClose: () => void;
}

/** Name a new folder, or rename one. */
export function FolderNameDialog({ title, action, initial = "", onSave, onClose }: FolderNameDialogProps) {
    const [name, setName] = useState(initial);
    const [saving, setSaving] = useState(false);
    const trimmed = name.trim();

    const save = async () => {
        if (!trimmed || saving) return;

        setSaving(true);
        await onSave(trimmed);
        onClose();
    };

    return (
        <Dialog
            title={title}
            onClose={onClose}
            onSubmit={() => void save()}
            footer={
                <>
                    <button type="button" className={controls.button} onClick={onClose}>
                        Cancel
                    </button>
                    <button type="submit" className={controls.primary} disabled={!trimmed || saving}>
                        {action}
                    </button>
                </>
            }
        >
            <label className={styles.field}>
                <span>Name</span>
                <input
                    className={controls.input}
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    spellCheck={false}
                    autoComplete="off"
                    autoFocus
                    onFocus={(e) => e.currentTarget.select()}
                />
            </label>
        </Dialog>
    );
}
