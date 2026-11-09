import { describe, expect, it } from "vitest";

import {
    abbreviateHome,
    colorTagVar,
    engineLabel,
    locationLabel,
    plural,
    relativeTime,
} from "@/lib/connections/connectionFormat";

describe("engineLabel", () => {
    it("shows the version when known", () => {
        expect(engineLabel({ engine: "postgres", server_version: "PostgreSQL 17.2" })).toBe("PostgreSQL 17.2");
        expect(engineLabel({ engine: "postgres", server_version: "PostgreSQL 17.2" }, true)).toBe("PostgreSQL 17");
        expect(engineLabel({ engine: "sqlite", server_version: "SQLite 3.46.1" }, true)).toBe("SQLite 3.46");
        expect(engineLabel({ engine: "sqlite", server_version: null })).toBe("SQLite");
    });
});

describe("locationLabel", () => {
    it("shows host and port, or the file path", () => {
        expect(locationLabel({ engine: "postgres", host: "db", port: null, file_path: null })).toBe("db:5432");
        expect(locationLabel({ engine: "postgres", host: "db", port: 6432, file_path: null })).toBe("db:6432");
        expect(locationLabel({ engine: "postgres", host: null, port: null, file_path: null })).toBe("");
        expect(
            locationLabel({ engine: "sqlite", host: null, port: null, file_path: "/Users/me/a.db" }, "/Users/me"),
        ).toBe("~/a.db");
    });

    it("abbreviates only whole home directories", () => {
        expect(abbreviateHome("/Users/meg/a.db", "/Users/me")).toBe("/Users/meg/a.db");
        expect(abbreviateHome("C:\\Users\\me\\a.db", "C:\\Users\\me\\")).toBe("~\\a.db");
        expect(abbreviateHome("/a.db", null)).toBe("/a.db");
    });
});

describe("relativeTime", () => {
    const now = new Date("2026-06-15T12:00:00Z");
    const ago = (ms: number) => new Date(now.getTime() - ms).toISOString();
    const min = 60_000;
    const day = 24 * 60 * min;

    it("rounds down to the largest unit", () => {
        expect(relativeTime(null, now)).toBe("never");
        expect(relativeTime(ago(10_000), now)).toBe("just now");
        expect(relativeTime(ago(2 * min), now)).toBe("2 min ago");
        expect(relativeTime(ago(61 * min), now)).toBe("1 h ago");
        expect(relativeTime(ago(30 * 60 * min), now)).toBe("yesterday");
        expect(relativeTime(ago(3 * day), now)).toBe("3 d ago");
        expect(relativeTime(ago(15 * day), now)).toBe("2 w ago");
        expect(relativeTime(ago(40 * day), now)).toBe("1 mo ago");
        expect(relativeTime(ago(800 * day), now)).toBe("2 y ago");
        expect(relativeTime(ago(-5 * min), now)).toBe("just now");
    });
});

describe("helpers", () => {
    it("pluralizes and maps color tags", () => {
        expect(plural(1, "connection")).toBe("1 connection");
        expect(plural(3, "folder")).toBe("3 folders");
        expect(colorTagVar("red")).toBe("var(--tag-red)");
        expect(colorTagVar("chartreuse")).toBeUndefined();
        expect(colorTagVar(null)).toBeUndefined();
    });
});
