import { Check } from "lucide-react";
import type { ReactNode } from "react";

import styles from "@/ui/Checkbox.module.css";

interface CheckboxProps {
    checked: boolean;
    onChange: (checked: boolean) => void;
    disabled?: boolean;
    children: ReactNode;
}

/** A native checkbox drawn as the Contrast square: filled with a check mark when on. */
export function Checkbox({ checked, onChange, disabled, children }: CheckboxProps) {
    return (
        <label className={styles.label} data-disabled={disabled || undefined}>
            <input
                type="checkbox"
                className={styles.input}
                checked={checked}
                disabled={disabled}
                onChange={(e) => onChange(e.target.checked)}
            />
            <span className={styles.box} aria-hidden="true">
                {checked && <Check size={10} strokeWidth={3} />}
            </span>
            {children}
        </label>
    );
}
