import type { Theme } from "@/lib/ipc/bindings";

export const THEMES: { value: Theme; label: string }[] = [
    { value: "light", label: "Light" },
    { value: "dark", label: "Dark" },
    { value: "system", label: "System" },
];

/** Sets `data-theme` on <html>. CSS resolves "system" with `prefers-color-scheme`. */
export function applyTheme(theme: Theme, root: HTMLElement = document.documentElement): void {
    root.dataset.theme = theme;
}
