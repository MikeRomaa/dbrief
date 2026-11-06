import { type RefObject, useEffect, useLayoutEffect, useRef, useState } from "react";

const GAP = 4;
const MARGIN = 8;

/**
 * Places a fixed-position popup under `anchor` (or above it near the bottom of the window), lined up
 * with its start or end edge and kept inside the window. With `matchWidth` the popup is at least as
 * wide as the anchor. `null` until measured: render the popup hidden until then.
 */
export function usePopoverPosition(
    ref: RefObject<HTMLElement | null>,
    anchor: HTMLElement,
    align: "start" | "end",
    matchWidth = false,
): { left: number; top: number; minWidth?: number } | null {
    const [position, setPosition] = useState<{ left: number; top: number; minWidth?: number } | null>(null);

    useLayoutEffect(() => {
        const popup = ref.current;
        if (!popup) return;

        const a = anchor.getBoundingClientRect();
        const width = Math.max(popup.offsetWidth, matchWidth ? a.width : 0);
        const height = popup.offsetHeight;
        let left = align === "end" ? a.right - width : a.left;
        left = Math.min(Math.max(MARGIN, left), window.innerWidth - width - MARGIN);
        let top = a.bottom + GAP;
        if (top + height > window.innerHeight - MARGIN) {
            top = Math.max(MARGIN, a.top - GAP - height);
        }

        setPosition({ left, top, minWidth: matchWidth ? a.width : undefined });
    }, [ref, anchor, align, matchWidth]);

    return position;
}

/** Calls `onClose` when the window resizes or scrolls outside the popup, which would strand it. */
export function useCloseOnScroll(ref: RefObject<HTMLElement | null>, onClose: () => void) {
    const onCloseRef = useRef(onClose);
    onCloseRef.current = onClose;

    useEffect(() => {
        const close = () => onCloseRef.current();
        const onWheel = (e: WheelEvent) => {
            if (!ref.current?.contains(e.target as Node)) close();
        };
        window.addEventListener("resize", close);
        window.addEventListener("wheel", onWheel, { passive: true });
        return () => {
            window.removeEventListener("resize", close);
            window.removeEventListener("wheel", onWheel);
        };
    }, [ref]);
}
