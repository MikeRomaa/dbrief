import { z } from "zod";

/**
 * Open editor tabs. A script tab is keyed by its path in the scripts folder. A preview tab (single
 * click in the side panel) is replaced by the next preview; double click or editing pins it.
 */
export interface Tab {
    path: string;
    preview: boolean;
}

export interface TabsState {
    tabs: Tab[];
    active: string | null;
}

export const EMPTY_TABS: TabsState = { tabs: [], active: null };

export type TabsAction =
    | { type: "open"; path: string; preview: boolean }
    | { type: "pin"; path: string }
    | { type: "activate"; path: string }
    | { type: "close"; path: string }
    | { type: "move"; path: string; to: number }
    | { type: "renamed"; from: string; to: string }
    | { type: "removed"; path: string }
    | { type: "replace"; state: TabsState };

/** Whether `path` is `folder` itself or inside it. */
const within = (path: string, folder: string) => path === folder || path.startsWith(`${folder}/`);

/** After closing the active tab, the one to its right takes over, else the one to its left. */
function nextActive(tabs: Tab[], closedIndex: number): string | null {
    return (tabs[closedIndex] ?? tabs[closedIndex - 1])?.path ?? null;
}

export function tabsReducer(state: TabsState, action: TabsAction): TabsState {
    switch (action.type) {
        case "open": {
            const existing = state.tabs.find((t) => t.path === action.path);
            if (existing) {
                const tabs = action.preview
                    ? state.tabs
                    : state.tabs.map((t) => (t.path === action.path ? { ...t, preview: false } : t));
                return { tabs, active: action.path };
            }

            const tab = { path: action.path, preview: action.preview };
            const previewIndex = action.preview ? state.tabs.findIndex((t) => t.preview) : -1;
            if (previewIndex >= 0) {
                const tabs = state.tabs.map((t, i) => (i === previewIndex ? tab : t));
                return { tabs, active: action.path };
            }

            // New tabs open to the right of the active one.
            const activeIndex = state.tabs.findIndex((t) => t.path === state.active);
            const at = activeIndex >= 0 ? activeIndex + 1 : state.tabs.length;
            const tabs = [...state.tabs.slice(0, at), tab, ...state.tabs.slice(at)];
            return { tabs, active: action.path };
        }
        case "pin":
            return {
                ...state,
                tabs: state.tabs.map((t) => (t.path === action.path ? { ...t, preview: false } : t)),
            };
        case "activate":
            return state.tabs.some((t) => t.path === action.path) ? { ...state, active: action.path } : state;
        case "close": {
            const index = state.tabs.findIndex((t) => t.path === action.path);
            if (index < 0) return state;

            const tabs = state.tabs.filter((t) => t.path !== action.path);
            return { tabs, active: state.active === action.path ? nextActive(tabs, index) : state.active };
        }
        case "move": {
            const index = state.tabs.findIndex((t) => t.path === action.path);
            const tab = state.tabs[index];
            if (!tab) return state;

            const rest = state.tabs.filter((t) => t.path !== action.path);
            const to = Math.max(0, Math.min(action.to, rest.length));
            return { ...state, tabs: [...rest.slice(0, to), tab, ...rest.slice(to)] };
        }
        case "renamed": {
            const rename = (path: string) =>
                within(path, action.from) ? action.to + path.slice(action.from.length) : path;
            return {
                tabs: state.tabs.map((t) => ({ ...t, path: rename(t.path) })),
                active: state.active === null ? null : rename(state.active),
            };
        }
        case "removed": {
            const tabs = state.tabs.filter((t) => !within(t.path, action.path));
            const activeGone = state.active !== null && within(state.active, action.path);
            const firstGone = state.tabs.findIndex((t) => within(t.path, action.path));
            return { tabs, active: activeGone ? nextActive(tabs, firstGone) : state.active };
        }
        case "replace":
            return action.state;
    }
}

/** `ui_state` key the open tabs are saved under. */
export const TABS_KEY = "tabs";

const savedTabs = z
    .object({
        tabs: z.array(z.object({ path: z.string(), preview: z.boolean().catch(false) })).catch([]),
        active: z.string().nullable().catch(null),
    })
    .catch(EMPTY_TABS);

export function serializeTabs(state: TabsState): string {
    return JSON.stringify({ version: 1, ...state });
}

/** Saved tabs; anything unreadable gives no tabs, and an active tab that isn't open is dropped. */
export function deserializeTabs(raw: string | null | undefined): TabsState {
    if (!raw) return EMPTY_TABS;

    let data: unknown;
    try {
        data = JSON.parse(raw);
    } catch {
        return EMPTY_TABS;
    }

    const state = savedTabs.parse(data);
    const active = state.tabs.some((t) => t.path === state.active) ? state.active : (state.tabs[0]?.path ?? null);
    return { tabs: state.tabs, active };
}
