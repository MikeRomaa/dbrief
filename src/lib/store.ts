import { useSyncExternalStore } from "react";

/**
 * A minimal observable value, for state that lives outside React's tree: results rendered inside
 * editor widgets, the Log, and the result shown in the bottom panel.
 */
export class Store<T> {
    private value: T;
    private readonly listeners = new Set<() => void>();

    constructor(value: T) {
        this.value = value;
    }

    get = (): T => this.value;

    set(value: T) {
        this.value = value;
        for (const listener of this.listeners) listener();
    }

    update(change: (value: T) => T) {
        this.set(change(this.value));
    }

    subscribe = (listener: () => void): (() => void) => {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    };
}

export function useStore<T>(store: Store<T>): T {
    return useSyncExternalStore(store.subscribe, store.get);
}
