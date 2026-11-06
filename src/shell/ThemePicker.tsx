import type { Theme } from "@/lib/bindings";
import { handleRovingKeyDown } from "@/lib/roving";
import { THEMES } from "@/theme/theme";

import styles from "@/shell/ThemePicker.module.css";

interface ThemePickerProps {
    value: Theme | undefined;
    onChange: (theme: Theme) => void;
    labelledBy: string;
    describedBy?: string;
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

/** Light / Dark / System cards as a radio group. Arrow keys move and select. */
export function ThemePicker({ value, onChange, labelledBy, describedBy }: ThemePickerProps) {
    return (
        <div
            role="radiogroup"
            aria-labelledby={labelledBy}
            aria-describedby={describedBy}
            className={styles.cards}
            onKeyDown={(e) => {
                const el = handleRovingKeyDown(e, '[role="radio"]', "horizontal");
                const picked = el?.dataset.value as Theme | undefined;
                if (picked) {
                    onChange(picked);
                }
            }}
        >
            {THEMES.map((theme) => {
                const checked = value === theme.value;

                return (
                    // biome-ignore lint/a11y/useSemanticElements: card-style radio with a custom preview; follows the WAI-ARIA radio group pattern.
                    <button
                        key={theme.value}
                        type="button"
                        role="radio"
                        aria-checked={checked}
                        data-value={theme.value}
                        tabIndex={checked || (!value && theme.value === "system") ? 0 : -1}
                        className={styles.card}
                        onClick={() => onChange(theme.value)}
                    >
                        <ThemePreview theme={theme.value} />
                        <span className={styles.cardLabel}>{theme.label}</span>
                    </button>
                );
            })}
        </div>
    );
}
