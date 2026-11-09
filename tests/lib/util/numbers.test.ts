import { describe, expect, it } from "vitest";

import { compactCount, formatBytes, formatCount } from "@/lib/util/numbers";

describe("number formats", () => {
    it("groups counts", () => {
        expect(formatCount(1284)).toBe("1,284");
    });

    it("shortens counts", () => {
        expect(compactCount(950)).toBe("950");
        expect(compactCount(1240)).toBe("1.2k");
        expect(compactCount(34_100)).toBe("34k");
        expect(compactCount(1_200_000)).toBe("1.2M");
        expect(compactCount(3_400_000_000)).toBe("3.4B");
    });

    it("formats bytes in powers of 1000", () => {
        expect(formatBytes(512)).toBe("512 B");
        expect(formatBytes(14_000)).toBe("14 kB");
        expect(formatBytes(1_250_000)).toBe("1.3 MB");
    });
});
