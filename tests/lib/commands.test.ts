import { describe, expect, it, vi } from "vitest";

import {
    ariaKeyShortcut,
    createCommandRegistry,
    formatShortcut,
    type KeyInput,
    matchesShortcut,
    parseShortcut,
} from "@/lib/commands";

function key(k: string, mods: Partial<KeyInput> = {}): KeyInput {
    return { key: k, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods };
}

describe("parseShortcut", () => {
    it("splits modifiers and key", () => {
        expect(parseShortcut("Mod+Shift+P")).toEqual({
            mod: true,
            ctrl: false,
            alt: false,
            shift: true,
            key: "p",
        });
    });

    it("keeps a literal plus key", () => {
        expect(parseShortcut("Mod++").key).toBe("+");
    });
});

describe("matchesShortcut", () => {
    it("uses Meta for Mod on macOS", () => {
        expect(matchesShortcut(key("b", { metaKey: true }), "Mod+B", "macos")).toBe(true);
        expect(matchesShortcut(key("b", { ctrlKey: true }), "Mod+B", "macos")).toBe(false);
    });

    it("uses Ctrl for Mod on Windows and Linux", () => {
        expect(matchesShortcut(key("b", { ctrlKey: true }), "Mod+B", "windows")).toBe(true);
        expect(matchesShortcut(key("b", { metaKey: true }), "Mod+B", "windows")).toBe(false);
    });

    it("requires modifiers to match exactly", () => {
        expect(matchesShortcut(key("b", { ctrlKey: true, shiftKey: true }), "Mod+B", "windows")).toBe(false);
        expect(matchesShortcut(key("b"), "Mod+B", "windows")).toBe(false);
    });

    it("is case-insensitive", () => {
        expect(matchesShortcut(key("B", { ctrlKey: true, shiftKey: true }), "Mod+Shift+b", "windows")).toBe(true);
    });

    it("matches by physical key when Option changes the character on macOS", () => {
        const input = key("∫", { code: "KeyB", metaKey: true, altKey: true });
        expect(matchesShortcut(input, "Mod+Alt+B", "macos")).toBe(true);
    });

    it("matches digits and punctuation by code", () => {
        expect(matchesShortcut(key("!", { code: "Digit1", ctrlKey: true }), "Mod+1", "windows")).toBe(true);
        expect(matchesShortcut(key(",", { code: "Comma", metaKey: true }), "Mod+,", "macos")).toBe(true);
    });
});

describe("formatShortcut", () => {
    it("uses symbols on macOS", () => {
        expect(formatShortcut("Mod+Alt+B", "macos")).toBe("⌥⌘B");
        expect(formatShortcut("Mod+Shift+P", "macos")).toBe("⇧⌘P");
    });

    it("uses Ctrl+ text elsewhere", () => {
        expect(formatShortcut("Mod+Alt+B", "windows")).toBe("Ctrl+Alt+B");
        expect(formatShortcut("Mod+,", "windows")).toBe("Ctrl+,");
    });
});

describe("ariaKeyShortcut", () => {
    it("maps Mod to Meta or Control", () => {
        expect(ariaKeyShortcut("Mod+B", "macos")).toBe("Meta+B");
        expect(ariaKeyShortcut("Mod+Alt+B", "windows")).toBe("Control+Alt+B");
    });
});

describe("createCommandRegistry", () => {
    it("runs the command whose shortcut matches", () => {
        const registry = createCommandRegistry("windows");
        const run = vi.fn();
        registry.register({ id: "a", label: "A", shortcut: "Mod+B", run });
        expect(registry.handleKey(key("b", { ctrlKey: true }))?.id).toBe("a");
        expect(run).toHaveBeenCalledOnce();
        expect(registry.handleKey(key("x", { ctrlKey: true }))).toBeUndefined();
    });

    it("unregisters only the command it registered", () => {
        const registry = createCommandRegistry("windows");
        const off1 = registry.register({ id: "a", label: "A", run: () => {} });
        registry.register({ id: "a", label: "A2", run: () => {} });
        off1();
        expect(registry.get("a")?.label).toBe("A2");
    });

    it("runs by id", () => {
        const registry = createCommandRegistry("macos");
        const run = vi.fn();
        registry.register({ id: "a", label: "A", run });
        expect(registry.run("a")).toBe(true);
        expect(registry.run("missing")).toBe(false);
        expect(run).toHaveBeenCalledOnce();
    });
});
