import { z } from "zod";

/** Fixed shell sizes in px. */
export const SIZES = {
    topBar: 36,
    rail: 44,
    statusBar: 24,
    sidePanel: { default: 248, min: 200, max: 420 },
    editorMinWidth: 320,
    editorMinHeight: 120,
    bottomPanel: { default: 220, min: 100, collapsed: 30 },
    inspector: 300,
} as const;

export const RAIL_ITEMS = ["connections", "explorer", "scripts", "history", "diagrams", "settings"] as const;
export type RailItem = (typeof RAIL_ITEMS)[number];

export interface LayoutState {
    sidePanelVisible: boolean;
    sidePanelWidth: number;
    bottomPanelCollapsed: boolean;
    bottomPanelHeight: number;
    inspectorVisible: boolean;
    activeRailItem: RailItem;
}

export const DEFAULT_LAYOUT: LayoutState = {
    sidePanelVisible: true,
    sidePanelWidth: SIZES.sidePanel.default,
    bottomPanelCollapsed: false,
    bottomPanelHeight: SIZES.bottomPanel.default,
    inspectorVisible: false,
    activeRailItem: "connections",
};

/** `ui_state` key the layout is saved under. */
export const LAYOUT_KEY = "layout";

const clamp = (value: number, min: number, max: number) =>
    Math.round(Math.min(Math.max(value, min), Math.max(min, max)));

/** Widest the side panel may be so the editor area keeps its 320px minimum. */
export function maxSidePanelWidth(windowWidth: number, inspectorVisible: boolean): number {
    const available = windowWidth - SIZES.rail - SIZES.editorMinWidth - (inspectorVisible ? SIZES.inspector : 0);
    return clamp(available, SIZES.sidePanel.min, SIZES.sidePanel.max);
}

export function clampSidePanelWidth(
    width: number,
    windowWidth = Number.POSITIVE_INFINITY,
    inspectorVisible = false,
): number {
    return clamp(width, SIZES.sidePanel.min, maxSidePanelWidth(windowWidth, inspectorVisible));
}

/** Tallest the bottom panel may be so the editor area keeps a usable height. */
export function maxBottomPanelHeight(windowHeight: number): number {
    return Math.max(SIZES.bottomPanel.min, windowHeight - SIZES.topBar - SIZES.statusBar - SIZES.editorMinHeight);
}

export function clampBottomPanelHeight(height: number, windowHeight = Number.POSITIVE_INFINITY): number {
    return clamp(height, SIZES.bottomPanel.min, maxBottomPanelHeight(windowHeight));
}

/** Height actually rendered for the bottom panel. */
export function bottomPanelRenderedHeight(layout: LayoutState, windowHeight: number): number {
    return layout.bottomPanelCollapsed
        ? SIZES.bottomPanel.collapsed
        : clampBottomPanelHeight(layout.bottomPanelHeight, windowHeight);
}

/** Width actually rendered for the side panel (0 when hidden). */
export function sidePanelRenderedWidth(layout: LayoutState, windowWidth: number): number {
    return layout.sidePanelVisible
        ? clampSidePanelWidth(layout.sidePanelWidth, windowWidth, layout.inspectorVisible)
        : 0;
}

export type LayoutAction =
    | { type: "toggleSidePanel" }
    | { type: "toggleBottomPanel" }
    | { type: "toggleInspector" }
    | { type: "setSidePanelWidth"; width: number }
    | { type: "setBottomPanelHeight"; height: number }
    | { type: "selectRailItem"; item: RailItem }
    | { type: "openRailItem"; item: RailItem }
    | { type: "replace"; layout: LayoutState };

export function layoutReducer(state: LayoutState, action: LayoutAction): LayoutState {
    switch (action.type) {
        case "toggleSidePanel":
            return { ...state, sidePanelVisible: !state.sidePanelVisible };
        case "toggleBottomPanel":
            return { ...state, bottomPanelCollapsed: !state.bottomPanelCollapsed };
        case "toggleInspector":
            return { ...state, inspectorVisible: !state.inspectorVisible };
        case "setSidePanelWidth":
            return { ...state, sidePanelWidth: clampSidePanelWidth(action.width) };
        case "setBottomPanelHeight":
            // Dragging below the minimum collapses the panel and keeps the last usable height.
            if (action.height < SIZES.bottomPanel.min) {
                return { ...state, bottomPanelCollapsed: true };
            }

            return {
                ...state,
                bottomPanelCollapsed: false,
                bottomPanelHeight: clampBottomPanelHeight(action.height),
            };
        case "selectRailItem":
            // Picking the active item again toggles the side panel, like VS Code.
            if (action.item === state.activeRailItem && state.sidePanelVisible) {
                return { ...state, sidePanelVisible: false };
            }

            return { ...state, activeRailItem: action.item, sidePanelVisible: true };
        case "openRailItem":
            return { ...state, activeRailItem: action.item, sidePanelVisible: true };
        case "replace":
            return action.layout;
    }
}

export function serializeLayout(layout: LayoutState): string {
    return JSON.stringify({ version: 1, ...layout });
}

/** Saved layout as stored in `ui_state`. Each bad or missing field falls back to its default; sizes are clamped. */
const savedLayoutSchema = z
    .object({
        sidePanelVisible: z.boolean().catch(DEFAULT_LAYOUT.sidePanelVisible),
        sidePanelWidth: z
            .number()
            .catch(DEFAULT_LAYOUT.sidePanelWidth)
            .transform((w) => clampSidePanelWidth(w)),
        bottomPanelCollapsed: z.boolean().catch(DEFAULT_LAYOUT.bottomPanelCollapsed),
        bottomPanelHeight: z
            .number()
            .catch(DEFAULT_LAYOUT.bottomPanelHeight)
            .transform((h) => clampBottomPanelHeight(h)),
        inspectorVisible: z.boolean().catch(DEFAULT_LAYOUT.inspectorVisible),
        activeRailItem: z.enum(RAIL_ITEMS).catch(DEFAULT_LAYOUT.activeRailItem),
    })
    .catch(DEFAULT_LAYOUT);

export function deserializeLayout(raw: string | null | undefined): LayoutState {
    if (!raw) {
        return DEFAULT_LAYOUT;
    }

    let data: unknown;
    try {
        data = JSON.parse(raw);
    } catch {
        return DEFAULT_LAYOUT;
    }

    return savedLayoutSchema.parse(data);
}
