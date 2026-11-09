export type Placement = "top" | "bottom" | "left" | "right";

export interface Rect {
    left: number;
    top: number;
    width: number;
    height: number;
}

export interface Size {
    width: number;
    height: number;
}

/** Gap between the anchor and the tooltip, and minimum distance from the window edge. */
export const TOOLTIP_GAP = 6;
export const VIEWPORT_MARGIN = 4;

const OPPOSITE: Record<Placement, Placement> = {
    top: "bottom",
    bottom: "top",
    left: "right",
    right: "left",
};

function place(anchor: Rect, tip: Size, placement: Placement): { left: number; top: number } {
    const cx = anchor.left + anchor.width / 2 - tip.width / 2;
    const cy = anchor.top + anchor.height / 2 - tip.height / 2;

    switch (placement) {
        case "top":
            return { left: cx, top: anchor.top - tip.height - TOOLTIP_GAP };
        case "bottom":
            return { left: cx, top: anchor.top + anchor.height + TOOLTIP_GAP };
        case "left":
            return { left: anchor.left - tip.width - TOOLTIP_GAP, top: cy };
        case "right":
            return { left: anchor.left + anchor.width + TOOLTIP_GAP, top: cy };
    }
}

function fits(pos: { left: number; top: number }, tip: Size, viewport: Size): boolean {
    return (
        pos.left >= VIEWPORT_MARGIN &&
        pos.top >= VIEWPORT_MARGIN &&
        pos.left + tip.width <= viewport.width - VIEWPORT_MARGIN &&
        pos.top + tip.height <= viewport.height - VIEWPORT_MARGIN
    );
}

const clamp = (v: number, min: number, max: number) => Math.min(Math.max(v, min), Math.max(min, max));

/**
 * Where to draw a tooltip next to `anchor`. Uses `preferred` if it fits, otherwise the opposite
 * side, then slides along the edge so the tooltip stays inside the window.
 */
export function computeTooltipPosition(
    anchor: Rect,
    tip: Size,
    viewport: Size,
    preferred: Placement,
): { left: number; top: number; placement: Placement } {
    let placement = preferred;
    let pos = place(anchor, tip, placement);

    if (!fits(pos, tip, viewport)) {
        const flipped = place(anchor, tip, OPPOSITE[preferred]);
        if (fits(flipped, tip, viewport)) {
            placement = OPPOSITE[preferred];
            pos = flipped;
        }
    }

    return {
        left: Math.round(clamp(pos.left, VIEWPORT_MARGIN, viewport.width - tip.width - VIEWPORT_MARGIN)),
        top: Math.round(clamp(pos.top, VIEWPORT_MARGIN, viewport.height - tip.height - VIEWPORT_MARGIN)),
        placement,
    };
}

/**
 * Tooltip attributes for any element. The element must still have its own accessible
 * name (aria-label or text); the tooltip is visual only.
 */
export function tooltip(
    text: string,
    options: { shortcut?: string; placement?: Placement } = {},
): Record<string, string> {
    const attrs: Record<string, string> = { "data-tooltip": text };

    if (options.shortcut) {
        attrs["data-tooltip-shortcut"] = options.shortcut;
    }

    if (options.placement) {
        attrs["data-tooltip-placement"] = options.placement;
    }

    return attrs;
}
