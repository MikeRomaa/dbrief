import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { computeTooltipPosition, type Placement } from "@/lib/shell/tooltip";

import styles from "@/components/shell/TooltipLayer.module.css";

const SHOW_DELAY_MS = 500;
/** Moving to another control within this time shows its tooltip at once. */
const WARM_MS = 400;

interface Shown {
    anchor: HTMLElement;
    text: string;
    shortcut?: string;
    placement: Placement;
}

function read(anchor: HTMLElement): Shown | null {
    const text = anchor.dataset.tooltip;
    if (!text) {
        return null;
    }

    return {
        anchor,
        text,
        shortcut: anchor.dataset.tooltipShortcut,
        placement: (anchor.dataset.tooltipPlacement as Placement | undefined) ?? "bottom",
    };
}

const anchorOf = (target: EventTarget | null) =>
    target instanceof Element ? target.closest<HTMLElement>("[data-tooltip]") : null;

/** One tooltip for the whole app, driven by `data-tooltip` attributes. Mount once. */
export function TooltipLayer() {
    const [shown, setShown] = useState<Shown | null>(null);
    const tipRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        let current: HTMLElement | null = null;
        let hiddenAt = 0;

        const show = (anchor: HTMLElement, delay: number) => {
            clearTimeout(timer);
            current = anchor;
            const warm = performance.now() - hiddenAt < WARM_MS;
            timer = setTimeout(() => setShown(read(anchor)), warm ? 0 : delay);
        };

        const hide = () => {
            clearTimeout(timer);

            if (current) {
                hiddenAt = performance.now();
            }

            current = null;
            setShown(null);
        };

        const onPointerOver = (e: PointerEvent) => {
            const anchor = anchorOf(e.target);
            if (anchor && anchor !== current) {
                show(anchor, SHOW_DELAY_MS);
            }
        };

        const onPointerOut = (e: PointerEvent) => {
            if (current && !current.contains(e.relatedTarget as Node | null)) {
                hide();
            }
        };

        const onFocusIn = (e: FocusEvent) => {
            const anchor = anchorOf(e.target);
            // Keyboard focus only; a mouse click should not pop a tooltip.
            if (anchor?.matches(":focus-visible")) {
                show(anchor, 0);
            }
        };

        const onKeyDown = (e: KeyboardEvent) => {
            if (e.key === "Escape") {
                hide();
            }
        };

        document.addEventListener("pointerover", onPointerOver);
        document.addEventListener("pointerout", onPointerOut);
        document.addEventListener("pointerdown", hide, true);
        document.addEventListener("focusin", onFocusIn);
        document.addEventListener("focusout", hide);
        document.addEventListener("keydown", onKeyDown, true);
        window.addEventListener("wheel", hide, { passive: true });
        window.addEventListener("blur", hide);

        return () => {
            clearTimeout(timer);
            document.removeEventListener("pointerover", onPointerOver);
            document.removeEventListener("pointerout", onPointerOut);
            document.removeEventListener("pointerdown", hide, true);
            document.removeEventListener("focusin", onFocusIn);
            document.removeEventListener("focusout", hide);
            document.removeEventListener("keydown", onKeyDown, true);
            window.removeEventListener("wheel", hide);
            window.removeEventListener("blur", hide);
        };
    }, []);

    // Measure, then position before paint so the tooltip never flashes in the wrong place.
    useLayoutEffect(() => {
        const tip = tipRef.current;
        if (!shown || !tip) return;

        const pos = computeTooltipPosition(
            shown.anchor.getBoundingClientRect(),
            { width: tip.offsetWidth, height: tip.offsetHeight },
            { width: window.innerWidth, height: window.innerHeight },
            shown.placement,
        );
        tip.style.left = `${pos.left}px`;
        tip.style.top = `${pos.top}px`;
        tip.dataset.placement = pos.placement;
        tip.dataset.ready = "true";
    }, [shown]);

    if (!shown) {
        return null;
    }

    return (
        // Visual only: the anchor already has an accessible name and aria-keyshortcuts.
        <div ref={tipRef} className={styles.tooltip} aria-hidden="true">
            <span>{shown.text}</span>
            {shown.shortcut && <kbd className={styles.shortcut}>{shown.shortcut}</kbd>}
        </div>
    );
}
