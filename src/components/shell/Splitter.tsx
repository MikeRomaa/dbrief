import type { KeyboardEvent, PointerEvent } from "react";
import { useRef } from "react";

import styles from "@/components/shell/Splitter.module.css";

interface SplitterProps {
    /** "vertical" = a vertical bar between side-by-side regions (resizes width). */
    orientation: "vertical" | "horizontal";
    label: string;
    /** id of the region this splitter resizes. */
    controls: string;
    value: number;
    min: number;
    max: number;
    /** Called with the new size in px while dragging or with arrow keys. */
    onChange: (value: number) => void;
    /**
     * +1 if moving the pointer right/down grows the region (side panel),
     * -1 if it shrinks it (bottom panel, inspector).
     */
    direction: 1 | -1;
    onDoubleClick?: () => void;
    valueText?: string;
}

const STEP = 10;
const BIG_STEP = 50;

export function Splitter({
    orientation,
    label,
    controls,
    value,
    min,
    max,
    onChange,
    direction,
    onDoubleClick,
    valueText,
}: SplitterProps) {
    const drag = useRef<{ start: number; startValue: number } | null>(null);
    const vertical = orientation === "vertical";

    const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
        if (e.button !== 0) return;

        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = { start: vertical ? e.clientX : e.clientY, startValue: value };
    };

    const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
        if (!drag.current) return;

        const delta = (vertical ? e.clientX : e.clientY) - drag.current.start;
        onChange(drag.current.startValue + delta * direction);
    };

    const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
        drag.current = null;

        if (e.currentTarget.hasPointerCapture(e.pointerId)) {
            e.currentTarget.releasePointerCapture(e.pointerId);
        }
    };

    const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
        const step = e.shiftKey ? BIG_STEP : STEP;
        // Arrow keys move the bar: "up" makes the bottom panel taller, "left" makes the inspector wider.
        const [forward, back] = vertical ? ["ArrowRight", "ArrowLeft"] : ["ArrowDown", "ArrowUp"];
        const grow = direction === 1 ? forward : back;
        const shrink = direction === 1 ? back : forward;
        let next: number | undefined;

        if (e.key === grow) {
            next = value + step;
        } else if (e.key === shrink) {
            next = value - step;
        } else if (e.key === "Home") {
            next = min;
        } else if (e.key === "End") {
            next = max;
        } else if (e.key === "Enter" && onDoubleClick) {
            e.preventDefault();
            onDoubleClick();

            return;
        }

        if (next !== undefined) {
            e.preventDefault();
            onChange(next);
        }
    };

    return (
        // biome-ignore lint/a11y/useSemanticElements: a focusable, resizable separator (WAI-ARIA window splitter) has no native element.
        <div
            role="separator"
            tabIndex={0}
            aria-label={label}
            aria-controls={controls}
            aria-orientation={orientation}
            aria-valuenow={Math.round(value)}
            aria-valuemin={min}
            aria-valuemax={max}
            aria-valuetext={valueText}
            className={vertical ? styles.vertical : styles.horizontal}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            onKeyDown={onKeyDown}
            onDoubleClick={onDoubleClick}
        />
    );
}
