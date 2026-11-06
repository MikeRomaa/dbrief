import type { Theme } from "@/lib/bindings";
import { handleRovingKeyDown } from "@/lib/roving";
import { THEMES } from "@/theme/theme";

import styles from "@/shell/SettingsView.module.css";

interface SettingsViewProps {
    theme: Theme | undefined;
    onThemeChange: (theme: Theme) => void;
}

/** Mini window drawing used inside a theme card. "system" shows half light, half dark. */
function ThemePreview({ theme }: { theme: Theme }) {
    return (
        <span className={styles.preview} data-preview={theme} aria-hidden="true">
            <span className={styles.previewHalf} data-tone="light">
                <span className={styles.previewRail} />
                <span className={styles.previewBody}>
                    <span className={styles.previewLine} />
                    <span className={styles.previewLine} data-short />
                </span>
            </span>
            <span className={styles.previewHalf} data-tone="dark">
                <span className={styles.previewRail} />
                <span className={styles.previewBody}>
                    <span className={styles.previewLine} />
                    <span className={styles.previewLine} data-short />
                </span>
            </span>
        </span>
    );
}

export function SettingsView({ theme, onThemeChange }: SettingsViewProps) {
    return (
        <div className={styles.view}>
            <h1 className={styles.title}>Settings</h1>
            <section id="settings-appearance" aria-labelledby="settings-appearance-title">
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
                    <div
                        role="radiogroup"
                        aria-labelledby="theme-label"
                        aria-describedby="theme-description"
                        className={styles.cards}
                        onKeyDown={(e) => {
                            const el = handleRovingKeyDown(e, '[role="radio"]', "horizontal");
                            const value = el?.dataset.value as Theme | undefined;
                            if (value) {
                                onThemeChange(value);
                            }
                        }}
                    >
                        {THEMES.map(({ value, label }) => {
                            const checked = theme === value;
                            return (
                                // biome-ignore lint/a11y/useSemanticElements: card-style radio with a custom preview; follows the WAI-ARIA radio group pattern.
                                <button
                                    key={value}
                                    type="button"
                                    role="radio"
                                    aria-checked={checked}
                                    data-value={value}
                                    tabIndex={checked || (!theme && value === "system") ? 0 : -1}
                                    className={styles.card}
                                    onClick={() => onThemeChange(value)}
                                >
                                    <ThemePreview theme={value} />
                                    <span className={styles.cardLabel}>{label}</span>
                                </button>
                            );
                        })}
                    </div>
                </div>
            </section>
        </div>
    );
}
