import { describe, expect, it } from "vitest";

import { fuzzyScore, rank } from "@/lib/util/search";

describe("fuzzyScore", () => {
    it("needs every character in order", () => {
        expect(fuzzyScore("x", "abc")).toBeNull();
        expect(fuzzyScore("ac", "abc")).not.toBeNull();
        expect(fuzzyScore("ca", "abc")).toBeNull();
        expect(fuzzyScore("", "anything")).toBe(0);
    });

    it("ranks exact, prefix and word-start matches higher (same as the Rust scorer)", () => {
        const s = (q: string, t: string) => fuzzyScore(q, t) ?? -Infinity;
        expect(s("orders", "orders")).toBeGreaterThan(s("orders", "orders_archive"));
        expect(s("ord", "orders")).toBeGreaterThan(s("ord", "old_orders"));
        expect(s("co", "customer_orders")).toBeGreaterThan(s("co", "discount"));
        expect(fuzzyScore("ci", "customerId")).not.toBeNull();
        expect(fuzzyScore("ORD", "orders")).toBe(fuzzyScore("ord", "orders"));
    });
});

describe("rank", () => {
    it("sorts best first and limits", () => {
        const items = ["daily_report.sql", "reports/monthly.sql", "readme"];
        expect(rank(items, "rep", (s) => s, 2)).toEqual(["reports/monthly.sql", "daily_report.sql"]);
    });
});
