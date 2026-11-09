import { describe, expect, it } from "vitest";

import { displayName, isTableKey, parseTableKey, tableKey } from "@/lib/tabs/tableTabs";
import { tabsReducer } from "@/lib/tabs/tabs";

describe("table tab keys", () => {
    it("round-trip odd names", () => {
        const table = { connectionId: "c1", schema: "My Schema/x", name: "a%b/c", kind: "view" as const };
        const key = tableKey(table);
        expect(isTableKey(key)).toBe(true);
        expect(parseTableKey(key)).toEqual(table);
    });

    it("are never script paths", () => {
        expect(parseTableKey("reports/daily.sql")).toBeNull();
        expect(parseTableKey("/scratchpad")).toBeNull();
        expect(parseTableKey("/table/c1/function/s/f")).toBeNull();
    });

    it("survive script folder renames and deletes", () => {
        const key = tableKey({ connectionId: "c1", schema: "public", name: "t", kind: "table" });
        const state = { tabs: [{ path: key, preview: false }], active: key };
        expect(tabsReducer(state, { type: "removed", path: "table" }).tabs).toHaveLength(1);
        expect(tabsReducer(state, { type: "renamed", from: "table", to: "x" }).tabs[0]?.path).toBe(key);
    });

    it("show schema only when it isn't the default", () => {
        expect(displayName("public", "users")).toBe("users");
        expect(displayName("main", "users")).toBe("users");
        expect(displayName("billing", "users")).toBe("billing.users");
    });
});
