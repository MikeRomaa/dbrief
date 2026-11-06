import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useState } from "react";

import { backend, type Settings } from "@/lib/backend";
import type { Theme } from "@/lib/bindings";
import { applyTheme } from "@/theme/theme";

export interface SettingsState {
    settings: Settings | null;
    warning: string | null;
    setTheme: (theme: Theme) => void;
}

export function useSettings(): SettingsState {
    const [settings, setSettings] = useState<Settings | null>(null);
    const [warning, setWarning] = useState<string | null>(null);

    useEffect(() => {
        backend
            .getSettings()
            .then((r) => {
                setSettings(r.settings);
                setWarning(r.warning);
            })
            .catch((e: unknown) => setWarning(`Could not load settings: ${String(e)}`));
    }, []);

    useEffect(() => {
        if (!settings) return;

        const { theme } = settings.appearance;

        applyTheme(theme);

        // Keep the native title bar in step; null lets it follow the OS.
        getCurrentWindow()
            .setTheme(theme === "system" ? null : theme)
            .catch(() => {});
    }, [settings]);

    const setTheme = (theme: Theme) => {
        if (!settings) return;

        const next = { ...settings, appearance: { ...settings.appearance, theme } };
        setSettings(next);

        backend
            .updateSettings(next)
            .then((r) => setWarning(r.warning))
            .catch((e: unknown) => setWarning(`Could not save settings: ${String(e)}`));
    };

    return { settings, warning, setTheme };
}
