import { useState } from "react";

import { backend } from "@/lib/backend";
import type { Theme } from "@/lib/bindings";
import { FolderField } from "@/shell/FolderField";
import { ThemePicker } from "@/shell/ThemePicker";

import styles from "@/shell/SettingsView.module.css";

interface SettingsViewProps {
    theme: Theme | undefined;
    onThemeChange: (theme: Theme) => void;
    scriptsFolder: string | undefined;
    onScriptsFolderChange: (path: string) => void;
}

export function SettingsView({ theme, onThemeChange, scriptsFolder, onScriptsFolderChange }: SettingsViewProps) {
    const [folderError, setFolderError] = useState<string | null>(null);

    const changeScriptsFolder = async (path: string) => {
        setFolderError(null);

        try {
            await backend.createScriptsFolder(path);
            onScriptsFolderChange(path);
        } catch (e) {
            setFolderError(`Could not create the scripts folder: ${String(e)}`);
        }
    };

    return (
        <div className={styles.view}>
            <h1 className={styles.title}>Settings</h1>
            <section id="settings-appearance" className={styles.section} aria-labelledby="settings-appearance-title">
                <h2 id="settings-appearance-title" className={styles.sectionTitle}>
                    Appearance
                </h2>
                <div className={styles.setting}>
                    <div id="theme-label" className={styles.settingLabel}>
                        Theme
                    </div>
                    <p id="theme-description" className={styles.settingDescription}>
                        System follows your operating system's light or dark setting.
                    </p>
                    <ThemePicker
                        value={theme}
                        onChange={onThemeChange}
                        labelledBy="theme-label"
                        describedBy="theme-description"
                    />
                </div>
            </section>
            <section id="settings-editor" className={styles.section} aria-labelledby="settings-editor-title">
                <h2 id="settings-editor-title" className={styles.sectionTitle}>
                    Editor
                </h2>
                <div className={styles.setting}>
                    <div id="scripts-folder-label" className={styles.settingLabel}>
                        Scripts folder
                    </div>
                    <p id="scripts-folder-description" className={styles.settingDescription}>
                        Your SQL scripts are saved here as plain .sql files. The folder is created if it doesn't exist.
                    </p>
                    <FolderField
                        value={scriptsFolder ?? ""}
                        onChange={(path) => void changeScriptsFolder(path)}
                        dialogTitle="Scripts folder"
                        labelledBy="scripts-folder-label"
                        describedBy="scripts-folder-description"
                    />
                    {folderError && (
                        <p className={styles.error} role="alert">
                            {folderError}
                        </p>
                    )}
                </div>
            </section>
        </div>
    );
}
