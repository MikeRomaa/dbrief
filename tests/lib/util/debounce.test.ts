import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { debounce } from "@/lib/util/debounce";

describe("debounce", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it("calls once with the latest arguments", () => {
        const fn = vi.fn();
        const d = debounce(fn, 100);
        d(1);
        d(2);
        vi.advanceTimersByTime(99);
        expect(fn).not.toHaveBeenCalled();
        vi.advanceTimersByTime(1);
        expect(fn).toHaveBeenCalledExactlyOnceWith(2);
    });

    it("flush runs a pending call immediately, and only once", () => {
        const fn = vi.fn();
        const d = debounce(fn, 100);
        d("x");
        d.flush();
        expect(fn).toHaveBeenCalledExactlyOnceWith("x");
        vi.advanceTimersByTime(200);
        d.flush();
        expect(fn).toHaveBeenCalledOnce();
    });

    it("cancel drops a pending call", () => {
        const fn = vi.fn();
        const d = debounce(fn, 100);
        d();
        d.cancel();
        vi.advanceTimersByTime(200);
        expect(fn).not.toHaveBeenCalled();
    });
});
