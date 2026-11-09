import { describe, expect, it } from "vitest";

import {
    deserializeTabs,
    EMPTY_TABS,
    serializeTabs,
    type TabsAction,
    type TabsState,
    tabsReducer,
} from "@/lib/tabs/tabs";

const run = (actions: TabsAction[], state: TabsState = EMPTY_TABS) => actions.reduce(tabsReducer, state);
const paths = (state: TabsState) => state.tabs.map((t) => (t.preview ? `(${t.path})` : t.path));

describe("tabsReducer", () => {
    it("replaces the preview tab and pins on double click", () => {
        let state = run([
            { type: "open", path: "a.sql", preview: true },
            { type: "open", path: "b.sql", preview: true },
        ]);
        expect(paths(state)).toEqual(["(b.sql)"]);

        state = run(
            [
                { type: "open", path: "b.sql", preview: false },
                { type: "open", path: "c.sql", preview: true },
            ],
            state,
        );
        expect(paths(state)).toEqual(["b.sql", "(c.sql)"]);
        expect(state.active).toBe("c.sql");

        state = run([{ type: "pin", path: "c.sql" }], state);
        expect(paths(state)).toEqual(["b.sql", "c.sql"]);
    });

    it("opens new tabs next to the active one and activates open ones", () => {
        const state = run([
            { type: "open", path: "a.sql", preview: false },
            { type: "open", path: "b.sql", preview: false },
            { type: "activate", path: "a.sql" },
            { type: "open", path: "c.sql", preview: false },
        ]);
        expect(paths(state)).toEqual(["a.sql", "c.sql", "b.sql"]);

        const again = run([{ type: "open", path: "b.sql", preview: true }], state);
        expect(paths(again)).toEqual(["a.sql", "c.sql", "b.sql"]);
        expect(again.active).toBe("b.sql");
    });

    it("closes to the right, then the left", () => {
        const open = run(["a", "b", "c"].map((p) => ({ type: "open", path: p, preview: false }) as const));
        expect(run([{ type: "close", path: "c" }], open).active).toBe("b");
        expect(
            run(
                [
                    { type: "activate", path: "a" },
                    { type: "close", path: "a" },
                ],
                open,
            ).active,
        ).toBe("b");
        expect(run([{ type: "close", path: "a" }], open).active).toBe("c");
        expect(
            run(
                [
                    { type: "close", path: "a" },
                    { type: "close", path: "b" },
                    { type: "close", path: "c" },
                ],
                open,
            ),
        ).toEqual(EMPTY_TABS);
    });

    it("reorders", () => {
        const open = run(["a", "b", "c"].map((p) => ({ type: "open", path: p, preview: false }) as const));
        expect(paths(run([{ type: "move", path: "c", to: 0 }], open))).toEqual(["c", "a", "b"]);
        expect(paths(run([{ type: "move", path: "a", to: 9 }], open))).toEqual(["b", "c", "a"]);
    });

    it("follows renames and deletes of scripts and folders", () => {
        const open = run(
            ["billing/a.sql", "billing/old/b.sql", "billing_x/c.sql", "d.sql"].map(
                (p) => ({ type: "open", path: p, preview: false }) as const,
            ),
        );
        const renamed = run(
            [
                { type: "activate", path: "billing/a.sql" },
                { type: "renamed", from: "billing", to: "finance" },
            ],
            open,
        );
        expect(paths(renamed)).toEqual(["finance/a.sql", "finance/old/b.sql", "billing_x/c.sql", "d.sql"]);
        expect(renamed.active).toBe("finance/a.sql");

        const removed = run([{ type: "removed", path: "finance" }], renamed);
        expect(paths(removed)).toEqual(["billing_x/c.sql", "d.sql"]);
        expect(removed.active).toBe("billing_x/c.sql");
    });
});

describe("saved tabs", () => {
    it("round-trips and drops what it can't read", () => {
        const state: TabsState = { tabs: [{ path: "a.sql", preview: true }], active: "a.sql" };
        expect(deserializeTabs(serializeTabs(state))).toEqual(state);
        expect(deserializeTabs("{bad")).toEqual(EMPTY_TABS);
        expect(deserializeTabs(null)).toEqual(EMPTY_TABS);
        expect(deserializeTabs(JSON.stringify({ tabs: [{ path: "a.sql" }], active: "gone.sql" }))).toEqual({
            tabs: [{ path: "a.sql", preview: false }],
            active: "a.sql",
        });
    });
});
