import { Eye, EyeOff } from "lucide-react";
import { useEffect, useState } from "react";

import { backend, errorMessage } from "@/lib/backend";
import type { DeleteCounts, ItemRef, SecretKind } from "@/lib/bindings";
import { plural } from "@/lib/connectionFormat";
import { Dialog } from "@/ui/Dialog";

import styles from "@/connections/ConnectionsView.module.css";
import controls from "@/ui/controls.module.css";

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

const SECRET_LABELS: Record<SecretKind, string> = {
    password: "Password",
    "ssh-password": "SSH password",
    "ssh-passphrase": "Private key passphrase",
};

/**
 * `problem` says why the last attempt failed (`null` when the secret hasn't been given yet).
 * `canRemember` offers "Save in keychain", which needs an OS credential store.
 */
interface SecretPromptProps {
    connectionName: string;
    secret: SecretKind;
    problem: string | null;
    canRemember: boolean;
    onSubmit: (value: string, remember: boolean) => void;
    onClose: () => void;
}

/** Asks for a password or passphrase that connecting needs. */
export function SecretPrompt({ connectionName, secret, problem, canRemember, onSubmit, onClose }: SecretPromptProps) {
    const [value, setValue] = useState("");
    const [visible, setVisible] = useState(false);
    const [remember, setRemember] = useState(true);
    const label = SECRET_LABELS[secret];

    return (
        <Dialog
            title={`Connect to ${connectionName}`}
            onClose={onClose}
            onSubmit={() => onSubmit(value, canRemember && remember)}
            footer={
                <>
                    <button type="button" className={controls.button} onClick={onClose}>
                        Cancel
                    </button>
                    <button type="submit" className={controls.primary}>
                        Connect
                    </button>
                </>
            }
        >
            {problem && (
                <p className={controls.error} role="alert">
                    {problem}
                </p>
            )}
            <label className={styles.field}>
                <span>{label}</span>
                <span className={styles.secretRow}>
                    <input
                        className={controls.input}
                        type={visible ? "text" : "password"}
                        value={value}
                        onChange={(e) => setValue(e.target.value)}
                        spellCheck={false}
                        autoComplete="off"
                        autoFocus
                    />
                    <button
                        type="button"
                        className={controls.iconButton}
                        aria-label={visible ? `Hide ${label.toLowerCase()}` : `Show ${label.toLowerCase()}`}
                        aria-pressed={visible}
                        onClick={() => setVisible((v) => !v)}
                    >
                        {visible ? <EyeOff size={14} /> : <Eye size={14} />}
                    </button>
                </span>
            </label>
            {canRemember ? (
                <label className={styles.checkbox}>
                    <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
                    Save in keychain
                </label>
            ) : (
                <p className={styles.dialogNote}>
                    No system keychain is available, so this is kept until DBrief quits.
                </p>
            )}
        </Dialog>
    );
}
