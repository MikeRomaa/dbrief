import { describe, expect, it } from "vitest";

import {
    bottomPanelRenderedHeight,
    clampBottomPanelHeight,
    clampSidePanelWidth,
    DEFAULT_LAYOUT,
    deserializeLayout,
    type LayoutState,
    layoutReducer,
    maxSidePanelWidth,
    SIZES,
    serializeLayout,
    sidePanelRenderedWidth,
} from "@/lib/layout";

describe("clamping", () => {
    it("keeps the side panel within 200–420", () => {
        expect(clampSidePanelWidth(50)).toBe(200);
        expect(clampSidePanelWidth(300.4)).toBe(300);
        expect(clampSidePanelWidth(9000)).toBe(420);
    });

    it("shrinks the side panel max so the editor keeps 320px", () => {
        // 900 - 44 rail - 320 editor = 536 → capped at 420
        expect(maxSidePanelWidth(900, false)).toBe(420);
        // 900 - 44 - 320 - 300 inspector = 236
        expect(maxSidePanelWidth(900, true)).toBe(236);
        // never below the 200 minimum
        expect(maxSidePanelWidth(600, true)).toBe(200);
        expect(clampSidePanelWidth(400, 900, true)).toBe(236);
    });

    it("keeps the bottom panel between its minimum and the window", () => {
        expect(clampBottomPanelHeight(10)).toBe(SIZES.bottomPanel.min);
        // 800 - 34 top - 24 status - 120 editor = 622
        expect(clampBottomPanelHeight(5000, 800)).toBe(622);
    });

    it("renders a collapsed bottom panel at 30px", () => {
        const layout = { ...DEFAULT_LAYOUT, bottomPanelCollapsed: true };
        expect(bottomPanelRenderedHeight(layout, 800)).toBe(30);
        expect(bottomPanelRenderedHeight(DEFAULT_LAYOUT, 800)).toBe(220);
    });

    it("renders a hidden side panel at 0px", () => {
        expect(sidePanelRenderedWidth({ ...DEFAULT_LAYOUT, sidePanelVisible: false }, 1280)).toBe(0);
        expect(sidePanelRenderedWidth(DEFAULT_LAYOUT, 1280)).toBe(248);
    });
});

describe("layoutReducer", () => {
    it("toggles panels", () => {
        let s = layoutReducer(DEFAULT_LAYOUT, { type: "toggleSidePanel" });
        expect(s.sidePanelVisible).toBe(false);
        s = layoutReducer(s, { type: "toggleBottomPanel" });
        expect(s.bottomPanelCollapsed).toBe(true);
        s = layoutReducer(s, { type: "toggleInspector" });
        expect(s.inspectorVisible).toBe(true);
    });

    it("clamps resize actions", () => {
        expect(layoutReducer(DEFAULT_LAYOUT, { type: "setSidePanelWidth", width: 999 }).sidePanelWidth).toBe(420);
    });

    it("collapses the bottom panel when dragged below its minimum, keeping the old height", () => {
        const s = layoutReducer(DEFAULT_LAYOUT, { type: "setBottomPanelHeight", height: 40 });
        expect(s.bottomPanelCollapsed).toBe(true);
        expect(s.bottomPanelHeight).toBe(220);
        const expanded = layoutReducer(s, { type: "setBottomPanelHeight", height: 300 });
        expect(expanded.bottomPanelCollapsed).toBe(false);
        expect(expanded.bottomPanelHeight).toBe(300);
    });

    it("selecting a rail item shows the side panel; selecting it again hides it", () => {
        const hidden = { ...DEFAULT_LAYOUT, sidePanelVisible: false };
        let s = layoutReducer(hidden, { type: "selectRailItem", item: "scripts" });
        expect(s).toMatchObject({ activeRailItem: "scripts", sidePanelVisible: true });
        s = layoutReducer(s, { type: "selectRailItem", item: "scripts" });
        expect(s).toMatchObject({ activeRailItem: "scripts", sidePanelVisible: false });
    });
});

describe("openRailItem", () => {
    it("always shows the side panel, even when the item is already active", () => {
        const s = layoutReducer(DEFAULT_LAYOUT, { type: "openRailItem", item: "connections" });
        expect(s).toMatchObject({ activeRailItem: "connections", sidePanelVisible: true });

        const hidden = { ...DEFAULT_LAYOUT, activeRailItem: "history" as const, sidePanelVisible: false };
        expect(layoutReducer(hidden, { type: "openRailItem", item: "connections" })).toMatchObject({
            activeRailItem: "connections",
            sidePanelVisible: true,
        });
    });
});

describe("serialization", () => {
    it("round-trips", () => {
        const layout: LayoutState = {
            sidePanelVisible: false,
            sidePanelWidth: 333,
            bottomPanelCollapsed: true,
            bottomPanelHeight: 180,
            inspectorVisible: true,
            activeRailItem: "history",
        };
        expect(deserializeLayout(serializeLayout(layout))).toEqual(layout);
    });

    it("falls back to defaults for missing, empty or broken data", () => {
        expect(deserializeLayout(null)).toEqual(DEFAULT_LAYOUT);
        expect(deserializeLayout("")).toEqual(DEFAULT_LAYOUT);
        expect(deserializeLayout("{not json")).toEqual(DEFAULT_LAYOUT);
        expect(deserializeLayout("42")).toEqual(DEFAULT_LAYOUT);
    });

    it("fixes individual bad fields and clamps sizes", () => {
        const raw = JSON.stringify({
            sidePanelVisible: "yes",
            sidePanelWidth: 5000,
            bottomPanelHeight: Number.NaN,
            activeRailItem: "nope",
            inspectorVisible: true,
        });
        expect(deserializeLayout(raw)).toEqual({
            ...DEFAULT_LAYOUT,
            sidePanelWidth: 420,
            inspectorVisible: true,
        });
    });
});
