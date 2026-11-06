import styles from "@/ui/Switch.module.css";

interface SwitchProps {
    label: string;
    checked: boolean;
    disabled?: boolean;
    onChange: (checked: boolean) => void;
}

/** A labelled on/off switch row. */
export function Switch({ label, checked, disabled, onChange }: SwitchProps) {
    return (
        <button
            type="button"
            role="switch"
            aria-checked={checked}
            className={styles.row}
            disabled={disabled}
            onClick={() => onChange(!checked)}
        >
            <span>{label}</span>
            <span className={styles.track} data-on={checked || undefined}>
                <span className={styles.thumb} />
            </span>
        </button>
    );
}
