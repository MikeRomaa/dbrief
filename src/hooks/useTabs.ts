import { type Dispatch, useEffect, useReducer, useRef, useState } from "react";

import { backend } from "@/lib/backend";
import { debounce } from "@/lib/debounce";
import {
    deserializeTabs,
    EMPTY_TABS,
    serializeTabs,
    TABS_KEY,
    type TabsAction,
    type TabsState,
    tabsReducer,
} from "@/lib/tabs";

/** Open tabs, restored on launch and saved to `ui_state` as they change. */
export function useTabs(): { tabs: TabsState; dispatch: Dispatch<TabsAction>; loaded: boolean } {
    const [tabs, dispatch] = useReducer(tabsReducer, EMPTY_TABS);
    const [loaded, setLoaded] = useState(false);
    const save = useRef(
        debounce((state: TabsState) => void backend.setUiState(TABS_KEY, serializeTabs(state)).catch(() => {}), 300),
    );

    useEffect(() => {
        backend
            .getUiState(TABS_KEY)
            .then((raw) => dispatch({ type: "replace", state: deserializeTabs(raw) }))
            .catch(() => {})
            .finally(() => setLoaded(true));
    }, []);

    useEffect(() => {
        if (loaded) save.current(tabs);
    }, [tabs, loaded]);

    return { tabs, dispatch, loaded };
}
