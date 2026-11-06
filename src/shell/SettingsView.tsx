import { useState } from "react";

import { backend, type Settings } from "@/lib/backend";
import type { Theme } from "@/lib/bindings";
import { FolderField } from "@/shell/FolderField";
import { ThemePicker } from "@/shell/ThemePicker";
import { Stepper } from "@/ui/Stepper";
import { Switch } from "@/ui/Switch";

import styles from "@/shell/SettingsView.module.css";

interface SettingsViewProps {
    settings: Settings | null;
    onThemeChange: (theme: Theme) => void;
    onScriptsFolderChange: (path: string) => void;
    onChange: (settings: Settings) => void;
}

export function SettingsView({ settings, onThemeChange, onScriptsFolderChange, onChange }: SettingsViewProps) {
    const theme = settings?.appearance.theme;
    const scriptsFolder = settings?.editor.scripts_folder;
    const setEditor = (change: Partial<Settings["editor"]>) =>
        settings && onChange({ ...settings, editor: { ...settings.editor, ...change } });
    const setDataGrid = (change: Partial<Settings["data_grid"]>) =>
        settings && onChange({ ...settings, data_grid: { ...settings.data_grid, ...change } });
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
            <h1 className="visually-hidden">Settings</h1>
            <section id="settings-appearance" className={styles.section} aria-labelledby="settings-appearance-title">
                <h2 id="settings-appearance-title" className={styles.sectionTitle}>
                    Appearance
                </h2>
                <div className={styles.setting}>
                    <div className={styles.settingText}>
                        <div id="theme-label">Theme</div>
                        <p id="theme-description" className={styles.settingDescription}>
                            System follows your operating system's light or dark setting.
                        </p>
                    </div>
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
                    <div className={styles.settingText}>
                        <div id="scripts-folder-label">Scripts folder</div>
                        <p id="scripts-folder-description" className={styles.settingDescription}>
                            Your SQL scripts are saved here as plain .sql files. The folder is created if it doesn't
                            exist.
                        </p>
                    </div>
                    <div className={styles.folderControl}>
                        <FolderField
                            value={scriptsFolder ?? ""}
                            onChange={(path) => void changeScriptsFolder(path)}
                            dialogTitle="Scripts folder"
                            labelledBy="scripts-folder-label"
                            describedBy="scripts-folder-description"
                        />
                    </div>
                </div>
                {folderError && (
                    <p className={styles.error} role="alert">
                        {folderError}
                    </p>
                )}
                {settings && (
                    <>
                        <div className={styles.setting}>
                            <div className={styles.settingText}>
                                <div>Show results inline</div>
                                <p className={styles.settingDescription}>
                                    Results appear under each statement instead of the bottom panel.
                                </p>
                            </div>
                            <span className={styles.switch}>
                                <Switch
                                    label="Show results inline"
                                    labelHidden
                                    checked={settings.editor.show_results_inline}
                                    onChange={(on) => setEditor({ show_results_inline: on })}
                                />
                            </span>
                        </div>
                        <div className={styles.setting}>
                            <div className={styles.settingText}>
                                <div id="inline-rows-label">Inline result rows</div>
                                <p className={styles.settingDescription}>Rows shown before an inline result scrolls.</p>
                            </div>
                            <Stepper
                                value={settings.editor.inline_result_rows}
                                min={5}
                                max={500}
                                step={5}
                                labelledBy="inline-rows-label"
                                onChange={(n) => setEditor({ inline_result_rows: n })}
                            />
                        </div>
                        <div className={styles.setting}>
                            <div className={styles.settingText}>
                                <div>Autocomplete</div>
                                <p className={styles.settingDescription}>
                                    Suggests SQL keywords and functions as you type.
                                </p>
                            </div>
                            <span className={styles.switch}>
                                <Switch
                                    label="Autocomplete"
                                    labelHidden
                                    checked={settings.editor.autocomplete}
                                    onChange={(on) => setEditor({ autocomplete: on })}
                                />
                            </span>
                        </div>
                        <div className={styles.setting}>
                            <div className={styles.settingText}>
                                <div>Format on save</div>
                                <p className={styles.settingDescription}>
                                    Formats a script when you leave its editor (scripts save as you type).
                                </p>
                            </div>
                            <span className={styles.switch}>
                                <Switch
                                    label="Format on save"
                                    labelHidden
                                    checked={settings.editor.format_on_save}
                                    onChange={(on) => setEditor({ format_on_save: on })}
                                />
                            </span>
                        </div>
                    </>
                )}
            </section>
            <section id="settings-data-grid" className={styles.section} aria-labelledby="settings-data-grid-title">
                <h2 id="settings-data-grid-title" className={styles.sectionTitle}>
                    Data grid
                </h2>
                {settings && (
                    <div className={styles.setting}>
                        <div className={styles.settingText}>
                            <div id="page-size-label">Page size</div>
                            <p className={styles.settingDescription}>
                                Rows fetched at a time; Load more fetches the next page.
                            </p>
                        </div>
                        <Stepper
                            value={settings.data_grid.page_size}
                            min={10}
                            max={10000}
                            step={50}
                            labelledBy="page-size-label"
                            onChange={(n) => setDataGrid({ page_size: n })}
                        />
                    </div>
                )}
            </section>
        </div>
    );
}
