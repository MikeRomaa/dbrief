import { useEffect, useState } from "react";

import { backend } from "@/lib/backend";

/** `ui_state` key set once the welcome screen has been completed. */
const FIRST_LAUNCH_KEY = "first_launch_done";

/**
 * Whether the welcome screen should show. `loaded` is false until the stored flag has been read;
 * `complete()` stores the flag so the welcome screen never shows again.
 */
export interface FirstLaunch {
    loaded: boolean;
    needed: boolean;
    complete: () => Promise<void>;
}

export function useFirstLaunch(): FirstLaunch {
    const [needed, setNeeded] = useState<boolean | null>(null);

    useEffect(() => {
        backend
            .getUiState(FIRST_LAUNCH_KEY)
            .then((value) => setNeeded(value === null))
            .catch(() => setNeeded(false)); // Unreadable state: don't block the app behind the welcome screen.
    }, []);

    const complete = async () => {
        await backend.setUiState(FIRST_LAUNCH_KEY, "true");
        setNeeded(false);
    };

    return { loaded: needed !== null, needed: needed === true, complete };
}
