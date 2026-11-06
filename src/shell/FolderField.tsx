import { open } from "@tauri-apps/plugin-dialog";

import styles from "@/shell/FolderField.module.css";

interface FolderFieldProps {
    value: string;
    onChange: (path: string) => void;
    dialogTitle: string;
    labelledBy: string;
    describedBy?: string;
}

/** Read-only folder path with a "Choose…" button that opens the OS folder picker. */
export function FolderField({ value, onChange, dialogTitle, labelledBy, describedBy }: FolderFieldProps) {
    const choose = async () => {
        const picked = await open({ directory: true, defaultPath: value || undefined, title: dialogTitle });
        if (typeof picked === "string") {
            onChange(picked);
        }
    };

    return (
        <div className={styles.row}>
            <input
                className={styles.path}
                type="text"
                value={value}
                readOnly
                spellCheck={false}
                aria-labelledby={labelledBy}
                aria-describedby={describedBy}
            />
            <button type="button" className={styles.choose} onClick={() => void choose()}>
                Choose…
            </button>
        </div>
    );
}
