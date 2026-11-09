import { postgresql } from "@/lib/engine/postgresql";
import { sqlite } from "@/lib/engine/sqlite";
import type { Engine } from "@/lib/ipc/bindings";

/**
 * What the frontend knows about a database engine, kept in one place per engine. `defaultSchema` is
 * where unqualified names resolve; `shortVersionParts` is how much of the server version a compact
 * label keeps; `caseInsensitiveIdentifiers` means mixed-case names need no quotes; `functions` are
 * the built-in functions the editor highlights and completes (lower case).
 */
export interface EngineProfile {
    name: string;
    defaultSchema: string;
    defaultPort: number | null;
    fileExtensions: readonly string[];
    formatterLanguage: "postgresql" | "sqlite";
    shortVersionParts: number;
    caseInsensitiveIdentifiers: boolean;
    functions: readonly string[];
}

export const engines: Record<Engine, EngineProfile> = { postgres: postgresql, sqlite };

/** Whether `schema` is an engine's default, which names can leave out. */
export function isDefaultSchema(schema: string): boolean {
    return Object.values(engines).some((e) => e.defaultSchema === schema);
}
