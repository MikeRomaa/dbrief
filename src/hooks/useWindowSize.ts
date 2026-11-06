import { useSyncExternalStore } from "react";

function subscribe(onChange: () => void) {
    window.addEventListener("resize", onChange);
    return () => window.removeEventListener("resize", onChange);
}

export function useWindowWidth(): number {
    return useSyncExternalStore(subscribe, () => window.innerWidth);
}

export function useWindowHeight(): number {
    return useSyncExternalStore(subscribe, () => window.innerHeight);
}
