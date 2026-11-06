import { useEffect, useState } from "react";

import logo from "@/assets/logo.svg";
import { backend } from "@/lib/backend";
import type { Theme } from "@/lib/bindings";
import { FolderField } from "@/shell/FolderField";
import { ThemePicker } from "@/shell/ThemePicker";

import styles from "@/shell/WelcomeScreen.module.css";

interface WelcomeScreenProps {
    theme: Theme | undefined;
    onThemeChange: (theme: Theme) => void;
    onDone: (scriptsFolder: string) => Promise<void>;
}

/** Shown once, on first launch: theme and scripts folder. `onDone` runs after the scripts folder has been created. */
export function WelcomeScreen({ theme, onThemeChange, onDone }: WelcomeScreenProps) {
    const [folder, setFolder] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [saving, setSaving] = useState(false);

    useEffect(() => {
        backend
            .defaultScriptsFolder()
            .then(setFolder)
            .catch((e: unknown) => setError(`Could not find your Documents folder: ${String(e)}`));
    }, []);

    const finish = async () => {
        setSaving(true);
        setError(null);

        try {
            await backend.createScriptsFolder(folder);
            await onDone(folder);
        } catch (e) {
            setError(`Could not create the scripts folder: ${String(e)}`);
            setSaving(false);
        }
    };

    return (
        <main className={styles.screen} aria-labelledby="welcome-title">
            <div className={styles.panel}>
                <header className={styles.header}>
                    <img className={styles.logo} src={logo} width={48} height={48} alt="" />
                    <h1 id="welcome-title" className={styles.title}>
                        Welcome to DBrief
                    </h1>
                    <p className={styles.subtitle}>
                        Two quick choices before you start. You can change both later in Settings.
                    </p>
                </header>

                <section className={styles.section} aria-labelledby="welcome-theme-label">
                    <h2 id="welcome-theme-label" className={styles.sectionTitle}>
                        Theme
                    </h2>
                    <p id="welcome-theme-description" className={styles.description}>
                        System follows your operating system's light or dark setting.
                    </p>
                    <ThemePicker
                        value={theme}
                        onChange={onThemeChange}
                        labelledBy="welcome-theme-label"
                        describedBy="welcome-theme-description"
                    />
                </section>

                <section className={styles.section} aria-labelledby="welcome-folder-label">
                    <h2 id="welcome-folder-label" className={styles.sectionTitle}>
                        Scripts folder
                    </h2>
                    <p id="welcome-folder-description" className={styles.description}>
                        Your SQL scripts are saved here as plain .sql files. The folder is created if it doesn't exist.
                    </p>
                    <FolderField
                        value={folder}
                        onChange={(path) => {
                            setFolder(path);
                            setError(null);
                        }}
                        dialogTitle="Scripts folder"
                        labelledBy="welcome-folder-label"
                        describedBy="welcome-folder-description"
                    />
                </section>

                {error && (
                    <p className={styles.error} role="alert">
                        {error}
                    </p>
                )}

                <footer className={styles.footer}>
                    <button
                        type="button"
                        className={styles.primary}
                        disabled={!folder || saving}
                        onClick={() => void finish()}
                    >
                        Get started
                    </button>
                </footer>
            </div>
        </main>
    );
}
