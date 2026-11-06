import styles from "@/ui/Switch.module.css";

interface SwitchProps {
    label: string;
    detail?: string;
    checked: boolean;
    disabled?: boolean;
    onChange: (checked: boolean) => void;
}

/** A labelled on/off switch row. */
export function Switch({ label, detail, checked, disabled, onChange }: SwitchProps) {
    return (
        <button
            type="button"
            role="switch"
            aria-checked={checked}
            className={styles.row}
            disabled={disabled}
            onClick={() => onChange(!checked)}
        >
            <span className={styles.text}>
                {label}
                {detail && <span className={styles.detail}>{detail}</span>}
            </span>
            <span className={styles.track} data-on={checked || undefined}>
                <span className={styles.thumb} />
            </span>
        </button>
    );
}
