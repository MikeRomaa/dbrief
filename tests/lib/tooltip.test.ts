import { describe, expect, it } from "vitest";

import { computeTooltipPosition, TOOLTIP_GAP, VIEWPORT_MARGIN } from "@/lib/tooltip";

const viewport = { width: 1000, height: 800 };
const tip = { width: 100, height: 24 };

describe("computeTooltipPosition", () => {
    it("centers below the anchor by default", () => {
        const anchor = { left: 450, top: 100, width: 100, height: 20 };
        expect(computeTooltipPosition(anchor, tip, viewport, "bottom")).toEqual({
            left: 450,
            top: 120 + TOOLTIP_GAP,
            placement: "bottom",
        });
    });

    it("places to the right, vertically centered", () => {
        const anchor = { left: 0, top: 100, width: 44, height: 34 };
        expect(computeTooltipPosition(anchor, tip, viewport, "right")).toEqual({
            left: 44 + TOOLTIP_GAP,
            top: 105,
            placement: "right",
        });
    });

    it("flips to the opposite side when the preferred side does not fit", () => {
        const anchor = { left: 450, top: 780, width: 100, height: 20 };
        const pos = computeTooltipPosition(anchor, tip, viewport, "bottom");
        expect(pos.placement).toBe("top");
        expect(pos.top).toBe(780 - 24 - TOOLTIP_GAP);
    });

    it("slides along the edge to stay inside the window", () => {
        const anchor = { left: 980, top: 100, width: 20, height: 20 };
        const pos = computeTooltipPosition(anchor, tip, viewport, "bottom");
        expect(pos.left).toBe(1000 - 100 - VIEWPORT_MARGIN);
        const left = computeTooltipPosition({ ...anchor, left: 0 }, tip, viewport, "bottom");
        expect(left.left).toBe(VIEWPORT_MARGIN);
    });

    it("keeps the preferred side when neither side fits", () => {
        const tall = { width: 100, height: 900 };
        const anchor = { left: 450, top: 400, width: 100, height: 20 };
        const pos = computeTooltipPosition(anchor, tall, viewport, "bottom");
        expect(pos.placement).toBe("bottom");
        expect(pos.top).toBe(VIEWPORT_MARGIN);
    });
});
