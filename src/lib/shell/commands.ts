import type { Platform } from "@tauri-apps/plugin-os";

/**
 * A shortcut written with `Mod` for ⌘ on macOS and Ctrl elsewhere, e.g. `Mod+B`, `Mod+Alt+B`,
 * `Mod+Shift+P`, `Mod+1`, `Mod+,`. The last part is the key.
 */
export type Shortcut = string;

export interface Command {
    id: string;
    label: string;
    shortcut?: Shortcut;
    run: () => void;
}

/** The parts of a KeyboardEvent that shortcut matching looks at. */
export interface KeyInput {
    key: string;
    code?: string;
    metaKey: boolean;
    ctrlKey: boolean;
    altKey: boolean;
    shiftKey: boolean;
}

interface ParsedShortcut {
    mod: boolean;
    ctrl: boolean;
    alt: boolean;
    shift: boolean;
    key: string;
}

export function parseShortcut(shortcut: Shortcut): ParsedShortcut {
    // Split on "+" but keep a literal "+" key (`Mod++`).
    const parts = shortcut.split(/\+(?!$)/);
    const key = (parts.pop() ?? "").toLowerCase();
    const mods = new Set(parts.map((p) => p.toLowerCase()));

    return {
        mod: mods.has("mod"),
        ctrl: mods.has("ctrl"),
        alt: mods.has("alt"),
        shift: mods.has("shift"),
        key,
    };
}

/** Maps `KeyboardEvent.code` to a key name, so Alt/Option combos still match on macOS. */
function keyFromCode(code: string | undefined): string | undefined {
    if (!code) {
        return undefined;
    }

    if (code.startsWith("Key")) {
        return code.slice(3).toLowerCase();
    }

    if (code.startsWith("Digit")) {
        return code.slice(5);
    }

    const named: Record<string, string> = {
        Comma: ",",
        Period: ".",
        Slash: "/",
        Backslash: "\\",
        BracketLeft: "[",
        BracketRight: "]",
        Semicolon: ";",
        Quote: "'",
        Backquote: "`",
        Minus: "-",
        Equal: "=",
    };

    return named[code];
}

export function matchesShortcut(input: KeyInput, shortcut: Shortcut, platform: Platform): boolean {
    const s = parseShortcut(shortcut);
    const wantMeta = platform === "macos" ? s.mod : false;
    const wantCtrl = platform === "macos" ? s.ctrl : s.mod || s.ctrl;

    if (input.metaKey !== wantMeta) {
        return false;
    }

    if (input.ctrlKey !== wantCtrl) {
        return false;
    }

    if (input.altKey !== s.alt) {
        return false;
    }

    if (input.shiftKey !== s.shift) {
        return false;
    }

    return input.key.toLowerCase() === s.key || keyFromCode(input.code) === s.key;
}

function displayKey(key: string): string {
    return key.length === 1 ? key.toUpperCase() : key[0]?.toUpperCase() + key.slice(1);
}

/** Text shown in tooltips and menus: `⌥⌘B` on macOS, `Ctrl+Alt+B` elsewhere. */
export function formatShortcut(shortcut: Shortcut, platform: Platform): string {
    const s = parseShortcut(shortcut);
    const key = displayKey(s.key);

    if (platform === "macos") {
        return `${s.ctrl ? "⌃" : ""}${s.alt ? "⌥" : ""}${s.shift ? "⇧" : ""}${s.mod ? "⌘" : ""}${key}`;
    }

    const parts: string[] = [];

    if (s.mod || s.ctrl) {
        parts.push("Ctrl");
    }

    if (s.alt) {
        parts.push("Alt");
    }

    if (s.shift) {
        parts.push("Shift");
    }

    parts.push(key);
    return parts.join("+");
}

/** Value for the `aria-keyshortcuts` attribute, e.g. `Meta+B` or `Control+Alt+B`. */
export function ariaKeyShortcut(shortcut: Shortcut, platform: Platform): string {
    const s = parseShortcut(shortcut);
    const parts: string[] = [];

    if (s.ctrl || (s.mod && platform !== "macos")) {
        parts.push("Control");
    }

    if (s.alt) {
        parts.push("Alt");
    }

    if (s.shift) {
        parts.push("Shift");
    }

    if (s.mod && platform === "macos") {
        parts.push("Meta");
    }

    parts.push(displayKey(s.key));
    return parts.join("+");
}

export interface CommandRegistry {
    register(command: Command): () => void;
    get(id: string): Command | undefined;
    list(): Command[];
    run(id: string): boolean;
    handleKey(input: KeyInput): Command | undefined;
}

export function createCommandRegistry(platform: Platform): CommandRegistry {
    const commands = new Map<string, Command>();
    return {
        register(command) {
            commands.set(command.id, command);
            return () => {
                if (commands.get(command.id) === command) {
                    commands.delete(command.id);
                }
            };
        },
        get: (id) => commands.get(id),
        list: () => [...commands.values()],
        run(id) {
            const command = commands.get(id);
            command?.run();

            return command !== undefined;
        },
        handleKey(input) {
            for (const command of commands.values()) {
                if (command.shortcut && matchesShortcut(input, command.shortcut, platform)) {
                    command.run();
                    return command;
                }
            }

            return undefined;
        },
    };
}
