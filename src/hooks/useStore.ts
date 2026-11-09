import { useSyncExternalStore } from "react";

import type { Store } from "@/lib/util/store";

export function useStore<T>(store: Store<T>): T {
    return useSyncExternalStore(store.subscribe, store.get);
}
