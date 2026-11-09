import type { Connection } from "@/lib/connections/connectionTree";
import type { AccessLevel, Engine } from "@/lib/ipc/bindings";

export const ENGINE_NAMES: Record<Engine, string> = {
    postgres: "PostgreSQL",
    sqlite: "SQLite",
};

export const ACCESS_LABELS: Record<AccessLevel, string> = {
    ro: "RO",
    rw: "RW",
    ddl: "DDL",
};

export const ACCESS_DESCRIPTIONS: Record<AccessLevel, string> = {
    ro: "Reads only. The database rejects any change.",
    rw: "Data edits allowed. Schema changes need a DDL connection.",
    ddl: "Data edits and schema changes allowed.",
};

/** Default port shown when a PostgreSQL connection doesn't set one. */
const POSTGRES_PORT = 5432;

/**
 * Engine and version. `short` keeps the major version for PostgreSQL ("PostgreSQL 17") and major.minor
 * for SQLite ("SQLite 3.46"); without a known version it is just the engine name.
 */
export function engineLabel(connection: Pick<Connection, "engine" | "server_version">, short = false): string {
    const name = ENGINE_NAMES[connection.engine];
    const version = connection.server_version?.split(" ").pop();
    if (!version || !/^\d/.test(version)) {
        return name;
    }

    if (!short) {
        return `${name} ${version}`;
    }

    const parts = version.split(".");
    const keep = connection.engine === "sqlite" ? 2 : 1;
    return `${name} ${parts.slice(0, keep).join(".")}`;
}

/** `~` for paths in the home directory, so file paths stay short. */
export function abbreviateHome(path: string, home: string | null): string {
    if (!home) {
        return path;
    }

    const trimmed = home.replace(/[\\/]+$/, "");
    if (path === trimmed) {
        return "~";
    }

    if (path.startsWith(`${trimmed}/`) || path.startsWith(`${trimmed}\\`)) {
        return `~${path.slice(trimmed.length)}`;
    }

    return path;
}

/** The Host column: `host:port` for servers, the file path for SQLite. */
export function locationLabel(
    connection: Pick<Connection, "engine" | "host" | "port" | "file_path">,
    home: string | null = null,
): string {
    if (connection.engine === "sqlite") {
        return abbreviateHome(connection.file_path ?? "", home);
    }

    return connection.host ? `${connection.host}:${connection.port ?? POSTGRES_PORT}` : "";
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** "2 min ago", "1 h ago", "yesterday", "3 d ago", "2 w ago", "1 mo ago", "2 y ago". */
export function relativeTime(iso: string | null, now: Date = new Date()): string {
    if (!iso) {
        return "never";
    }

    const then = new Date(iso).getTime();
    if (Number.isNaN(then)) {
        return "never";
    }

    const elapsed = Math.max(0, now.getTime() - then);
    if (elapsed < MINUTE) return "just now";
    if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)} min ago`;
    if (elapsed < DAY) return `${Math.floor(elapsed / HOUR)} h ago`;
    if (elapsed < 2 * DAY) return "yesterday";
    if (elapsed < 7 * DAY) return `${Math.floor(elapsed / DAY)} d ago`;
    if (elapsed < 30 * DAY) return `${Math.floor(elapsed / (7 * DAY))} w ago`;
    if (elapsed < 365 * DAY) return `${Math.floor(elapsed / (30 * DAY))} mo ago`;
    return `${Math.floor(elapsed / (365 * DAY))} y ago`;
}

/** "3 connections" / "1 connection". */
export function plural(count: number, noun: string): string {
    return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** Color tags offered for connections; each maps to a `--tag-<name>` color. */
export const COLOR_TAGS = ["red", "orange", "green", "blue", "purple"] as const;
export type ColorTag = (typeof COLOR_TAGS)[number];

export function colorTagVar(tag: string | null): string | undefined {
    return tag && (COLOR_TAGS as readonly string[]).includes(tag) ? `var(--tag-${tag})` : undefined;
}
