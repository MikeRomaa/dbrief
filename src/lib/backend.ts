import { commands, type Settings_Serialize, type SettingsResponse_Serialize } from "@/lib/bindings";

export type Settings = Settings_Serialize;
export type SettingsResponse = SettingsResponse_Serialize;

/** Turns a tauri-specta result into a value, throwing on the error variant. */
async function unwrap<T>(result: Promise<{ status: "ok"; data: T } | { status: "error"; error: string }>): Promise<T> {
    const r = await result;
    if (r.status === "error") {
        throw new Error(r.error);
    }

    return r.data;
}

export const backend = {
    getSettings: (): Promise<SettingsResponse> => unwrap(commands.getSettings()),
    updateSettings: (settings: Settings): Promise<SettingsResponse> => unwrap(commands.updateSettings(settings)),
    getUiState: (key: string): Promise<string | null> => unwrap(commands.getUiState(key)),
    setUiState: (key: string, value: string): Promise<null> => unwrap(commands.setUiState(key, value)),
    defaultScriptsFolder: (): Promise<string> => unwrap(commands.defaultScriptsFolder()),
    createScriptsFolder: (path: string): Promise<null> => unwrap(commands.createScriptsFolder(path)),
};
