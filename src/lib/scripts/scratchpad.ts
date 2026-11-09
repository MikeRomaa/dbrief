import { backend } from "@/lib/ipc/backend";

/**
 * The tab key of the Scratchpad: SQL to try out without a file. Script paths are relative and never
 * start with "/", so no file can take this key. Its text is kept in the app database; its connection,
 * schema and parameters use the same per-script settings as files.
 */
export const SCRATCHPAD = "/scratchpad";

const TEXT_KEY = "scratchpad";

export const isScratchpad = (path: string) => path === SCRATCHPAD;

/** A tab's text, from its file or, for the Scratchpad, from the app database. */
export async function readTabText(path: string): Promise<string> {
    return isScratchpad(path) ? ((await backend.getUiState(TEXT_KEY)) ?? "") : backend.readScript(path);
}

export async function writeTabText(path: string, text: string): Promise<void> {
    if (isScratchpad(path)) {
        await backend.setUiState(TEXT_KEY, text);
    } else {
        await backend.writeScript(path, text);
    }
}

/** The name shown in tabs and logs. */
export function tabTitle(path: string): string {
    return isScratchpad(path) ? "Scratchpad" : path.slice(path.lastIndexOf("/") + 1);
}
