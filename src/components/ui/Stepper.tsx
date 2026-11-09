import { Minus, Plus } from "lucide-react";
import { useEffect, useState } from "react";

import styles from "@/components/ui/Stepper.module.css";

/** A whole number between `min` and `max`, typed or stepped with − and +. */
export function Stepper({
    value,
    min,
    max,
    step = 1,
    labelledBy,
    onChange,
}: {
    value: number;
    min: number;
    max: number;
    step?: number;
    labelledBy: string;
    onChange: (value: number) => void;
}) {
    const [text, setText] = useState(String(value));
    useEffect(() => setText(String(value)), [value]);

    const commit = (next: number) => {
        const clamped = Math.min(max, Math.max(min, Math.round(next)));
        setText(String(clamped));
        if (clamped !== value) onChange(clamped);
    };

    return (
        <span className={styles.stepper}>
            <button type="button" aria-label="Decrease" disabled={value <= min} onClick={() => commit(value - step)}>
                <Minus size={12} />
            </button>
            <input
                inputMode="numeric"
                aria-labelledby={labelledBy}
                value={text}
                onChange={(e) => setText(e.target.value.replace(/\D/g, ""))}
                onBlur={() => commit(Number(text) || min)}
                onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
            />
            <button type="button" aria-label="Increase" disabled={value >= max} onClick={() => commit(value + step)}>
                <Plus size={12} />
            </button>
        </span>
    );
}
