import { describe, expect, it } from "vitest";

import { nextRovingIndex } from "@/lib/roving";

describe("nextRovingIndex", () => {
    it("moves along the orientation's arrow keys and wraps", () => {
        expect(nextRovingIndex(0, 3, "ArrowDown", "vertical")).toBe(1);
        expect(nextRovingIndex(2, 3, "ArrowDown", "vertical")).toBe(0);
        expect(nextRovingIndex(0, 3, "ArrowUp", "vertical")).toBe(2);
        expect(nextRovingIndex(1, 3, "ArrowRight", "horizontal")).toBe(2);
    });

    it("ignores cross-axis arrows and other keys", () => {
        expect(nextRovingIndex(0, 3, "ArrowRight", "vertical")).toBeUndefined();
        expect(nextRovingIndex(0, 3, "a", "horizontal")).toBeUndefined();
        expect(nextRovingIndex(0, 0, "ArrowDown", "vertical")).toBeUndefined();
    });

    it("jumps with Home and End", () => {
        expect(nextRovingIndex(1, 4, "Home", "horizontal")).toBe(0);
        expect(nextRovingIndex(1, 4, "End", "horizontal")).toBe(3);
    });
});
