import { getCurrentWindow } from "@tauri-apps/api/window";
import { type Dispatch, useEffect, useReducer, useRef, useState } from "react";

import { backend } from "@/lib/backend";
import { debounce } from "@/lib/debounce";
import {
    DEFAULT_LAYOUT,
    deserializeLayout,
    LAYOUT_KEY,
    type LayoutAction,
    type LayoutState,
    layoutReducer,
    serializeLayout,
} from "@/lib/layout";

const SAVE_DELAY_MS = 400;

export interface LayoutStore {
    layout: LayoutState;
    dispatch: Dispatch<LayoutAction>;
    loaded: boolean;
    saveError: string | null;
}

export function useLayout(): LayoutStore {
    const [layout, dispatch] = useReducer(layoutReducer, DEFAULT_LAYOUT);
    const [loaded, setLoaded] = useState(false);
    const [saveError, setSaveError] = useState<string | null>(null);
    const saveRef = useRef<ReturnType<typeof debounce<[LayoutState]>> | null>(null);
    const latestRef = useRef(layout);
    const loadedRef = useRef(false);

    useEffect(() => {
        const save = debounce((value: LayoutState) => {
            backend
                .setUiState(LAYOUT_KEY, serializeLayout(value))
                .then(() => setSaveError(null))
                .catch((e: unknown) => setSaveError(`Could not save layout: ${String(e)}`));
        }, SAVE_DELAY_MS);

        saveRef.current = save;

        // Write any pending change before the page unloads (e.g. a webview reload).
        const flush = () => save.flush();
        window.addEventListener("pagehide", flush);

        // pagehide is not guaranteed when the window closes, so also save on close.
        // Awaiting the write here makes Tauri wait for it before the window is destroyed.
        const unlisten = getCurrentWindow().onCloseRequested(async () => {
            save.cancel();

            if (loadedRef.current) {
                await backend.setUiState(LAYOUT_KEY, serializeLayout(latestRef.current)).catch(() => {});
            }
        });

        return () => {
            window.removeEventListener("pagehide", flush);
            void unlisten.then((off) => off());
            save.flush();
        };
    }, []);

    useEffect(() => {
        let cancelled = false;
        backend
            .getUiState(LAYOUT_KEY)
            .then((raw) => {
                if (!cancelled) {
                    dispatch({ type: "replace", layout: deserializeLayout(raw) });
                }
            })
            .catch(() => {}) // Unreadable layout: keep defaults.
            .finally(() => {
                if (!cancelled) {
                    setLoaded(true);
                }
            });
        return () => {
            cancelled = true;
        };
    }, []);

    useEffect(() => {
        latestRef.current = layout;
        loadedRef.current = loaded;

        if (loaded) {
            saveRef.current?.(layout);
        }
    }, [layout, loaded]);

    return { layout, dispatch, loaded, saveError };
}
