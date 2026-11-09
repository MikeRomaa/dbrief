import { handleRovingKeyDown } from "@/lib/util/roving";

import styles from "@/components/ui/Segmented.module.css";

interface SegmentedProps<T extends string> {
    value: T;
    options: readonly { value: T; label: string }[];
    onChange: (value: T) => void;
    labelledBy?: string;
    label?: string;
    describedBy?: string;
    fill?: boolean;
}

/** Joined buttons that pick one option (WAI-ARIA radio group: arrows move and select). */
export function Segmented<T extends string>({
    value,
    options,
    onChange,
    labelledBy,
    label,
    describedBy,
    fill = false,
}: SegmentedProps<T>) {
    return (
        <div
            role="radiogroup"
            aria-labelledby={labelledBy}
            aria-label={label}
            aria-describedby={describedBy}
            className={styles.group}
            data-fill={fill || undefined}
            onKeyDown={(e) => {
                const el = handleRovingKeyDown(e, '[role="radio"]', "horizontal");
                const picked = options.find((o) => o.value === el?.dataset.value);
                if (picked) onChange(picked.value);
            }}
        >
            {options.map((option) => (
                // biome-ignore lint/a11y/useSemanticElements: segmented control; follows the WAI-ARIA radio group pattern, like ThemePicker.
                <button
                    key={option.value}
                    type="button"
                    role="radio"
                    data-value={option.value}
                    aria-checked={option.value === value}
                    tabIndex={option.value === value ? 0 : -1}
                    className={styles.segment}
                    onClick={() => onChange(option.value)}
                >
                    {option.label}
                </button>
            ))}
        </div>
    );
}
