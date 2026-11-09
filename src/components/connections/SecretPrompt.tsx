import { Eye, EyeOff } from "lucide-react";
import { useState } from "react";

import { Dialog } from "@/components/ui/Dialog";
import type { SecretKind } from "@/lib/ipc/bindings";

import styles from "@/components/connections/ConnectionsView.module.css";
import controls from "@/components/ui/controls.module.css";

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
