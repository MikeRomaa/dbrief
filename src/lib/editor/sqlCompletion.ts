import type { Completion, CompletionContext, CompletionResult, CompletionSource } from "@codemirror/autocomplete";
import { PostgreSQL, SQLDialect, SQLite, type SQLNamespace } from "@codemirror/lang-sql";
import { syntaxTree } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";

import { engines } from "@/lib/engine";
import type { CompletionTable, SchemaObject } from "@/lib/ipc/bindings";
import type { Dialect } from "@/lib/sql/statements";

/**
 * Autocomplete for the script editor: the dialects (with their built-in functions, so those are
 * highlighted and completed like keywords), keyword completions in upper case, and the namespace of
 * schemas, tables, views, indexes, sequences, triggers, functions and columns from the schema cache.
 * Columns of the tables a statement uses complete unqualified too (`columnsInScope`).
 * Completion types double as the class that colors each option (see `completionOptionClass`).
 */

function words(list: string): string[] {
    return list.split(/\s+/).filter(Boolean);
}

const FUNCTIONS: Record<Dialect, ReadonlySet<string>> = {
    postgres: new Set(engines.postgres.functions.map((f) => f.toUpperCase())),
    sqlite: new Set(engines.sqlite.functions.map((f) => f.toUpperCase())),
};

/** `base` with the engine's functions it doesn't already know as keywords or types added as built-ins. */
function withFunctions(base: SQLDialect, dialect: Dialect, replaceBuiltin: boolean): SQLDialect {
    const { functions, caseInsensitiveIdentifiers } = engines[dialect];
    const known = new Set(words(`${base.spec.keywords ?? ""} ${base.spec.types ?? ""}`));
    const extra = functions.filter((f) => !known.has(f));
    const builtin = replaceBuiltin ? extra : [...words(base.spec.builtin ?? ""), ...extra];
    return SQLDialect.define({ ...base.spec, builtin: builtin.join(" "), caseInsensitiveIdentifiers });
}

// SQLite's own built-ins are the sqlite3 shell's dot-commands, which never reach the database.
const DIALECTS: Record<Dialect, SQLDialect> = {
    postgres: withFunctions(PostgreSQL, "postgres", false),
    sqlite: withFunctions(SQLite, "sqlite", true),
};

export function sqlDialect(dialect: Dialect): SQLDialect {
    return DIALECTS[dialect];
}

/** Builds lang-sql's keyword completions (already upper-cased): built-in functions get their own type. */
export function keywordCompletion(dialect: Dialect): (label: string, type: string) => Completion {
    const functions = FUNCTIONS[dialect];
    return (label, type) => ({
        label,
        type: functions.has(label) ? "function builtin" : type === "variable" ? "keyword" : type,
        boost: -1,
    });
}

/** Classes for an option's `<li>`, one per word of its type (`cm-completion-keyword`, …). */
export function completionOptionClass(completion: Completion): string {
    return (completion.type ?? "")
        .split(/\s+/)
        .filter(Boolean)
        .map((t) => `cm-completion-${t}`)
        .join(" ");
}

const KINDS: Record<SchemaObject["kind"], { type: string; label: string }> = {
    schema: { type: "namespace", label: "schema" },
    table: { type: "table", label: "table" },
    view: { type: "view", label: "view" },
    "materialized-view": { type: "view", label: "materialized view" },
    function: { type: "function", label: "function" },
    sequence: { type: "sequence", label: "sequence" },
    index: { type: "index", label: "index" },
    trigger: { type: "trigger", label: "trigger" },
};

// Later kinds win a name clash within a schema, so tables and views keep their columns.
const ORDER: SchemaObject["kind"][] = [
    "trigger",
    "function",
    "sequence",
    "index",
    "materialized-view",
    "view",
    "table",
];

type Level = Record<string, SQLNamespace>;

/** Keys of a namespace object split on dots; names that contain one need it escaped. */
function key(name: string): string {
    return name.replace(/\./g, "\\.");
}

/** A completion for an identifier, quoted on insert when it wouldn't survive unquoted. */
function identifier(name: string, dialect: Dialect, completion: Omit<Completion, "label">): Completion {
    const plain = engines[dialect].caseInsensitiveIdentifiers ? /^[a-z_][a-z_\d$]*$/i : /^[a-z_][a-z_\d$]*$/;
    return plain.test(name)
        ? { ...completion, label: name }
        : { ...completion, label: name, apply: `"${name.replace(/"/g, '""')}"` };
}

function detailOf(object: SchemaObject): string {
    const kind = KINDS[object.kind].label;
    if (object.kind === "function") return object.detail ? `${kind} ${object.detail}` : kind;
    return object.parent ? `${kind} on ${object.parent}` : kind;
}

/**
 * The namespace autocomplete walks — schema → object → columns — from the schema's objects and every
 * table's columns. Each entry carries its kind as the completion type, with a short detail.
 */
export function completionNamespace(
    objects: readonly SchemaObject[],
    tables: readonly CompletionTable[],
    dialect: Dialect,
): SQLNamespace {
    const columns = new Map<string, string[]>();
    for (const t of tables) columns.set(`${t.schema}\u0000${t.table}`, t.columns);

    const schemas = new Map<string, Level>();
    const levelOf = (schema: string) => {
        let level = schemas.get(schema);
        if (!level) {
            level = {};
            schemas.set(schema, level);
        }
        return level;
    };

    for (const schema of objects.filter((o) => o.kind === "schema")) levelOf(schema.name);

    for (const kind of ORDER) {
        for (const object of objects) {
            if (object.kind !== kind) continue;
            levelOf(object.schema)[key(object.name)] = {
                self: identifier(object.name, dialect, { type: KINDS[kind].type, detail: detailOf(object) }),
                children: columns.get(`${object.schema}\u0000${object.name}`) ?? [],
            };
        }
    }

    // Tables the schema list doesn't have yet (it lags a refresh) still complete with their columns.
    for (const t of tables) {
        const level = levelOf(t.schema);
        if (!level[key(t.table)]) {
            level[key(t.table)] = {
                self: identifier(t.table, dialect, { type: "table", detail: "table" }),
                children: t.columns,
            };
        }
    }

    const namespace: Level = {};
    for (const [schema, level] of schemas) {
        namespace[key(schema)] = {
            self: identifier(schema, dialect, { type: "namespace", detail: "schema" }),
            children: level,
        };
    }
    return namespace;
}

interface SelfTagged {
    self: Completion;
    children: SQLNamespace;
}

function isSelfTagged(ns: SQLNamespace): ns is SelfTagged {
    return !Array.isArray(ns) && "self" in ns && "children" in ns;
}

/** The entry `name` of a namespace level (unquoted names fold to lower case, as Postgres does). */
function childOf(level: SQLNamespace | undefined, name: string): SQLNamespace | undefined {
    if (!level) return undefined;
    const children = isSelfTagged(level) ? level.children : level;
    if (Array.isArray(children)) return undefined;
    const map = children as Record<string, SQLNamespace>;
    return map[key(name)] ?? map[key(name.toLowerCase())];
}

function columnNames(entry: SQLNamespace | undefined): string[] {
    if (!entry) return [];
    const children = isSelfTagged(entry) ? entry.children : entry;
    return Array.isArray(children) ? children.map((c) => (typeof c === "string" ? c : c.label)) : [];
}

/** The columns of the table `path` names (`table`, `schema.table` or `db.schema.table`). */
function tableColumns(namespace: SQLNamespace, defaultSchema: string | undefined, path: string[]): string[] {
    const [table, schema] = [path[path.length - 1], path[path.length - 2]];
    if (!table) return [];
    if (schema) return columnNames(childOf(childOf(namespace, schema), table));
    if (defaultSchema) {
        const found = childOf(childOf(namespace, defaultSchema), table);
        if (found) return columnNames(found);
    }
    if (Array.isArray(namespace)) return [];
    for (const schemaName of Object.keys(namespace)) {
        const found = childOf(childOf(namespace, schemaName.replace(/\\\./g, ".")), table);
        if (found) return columnNames(found);
    }
    return [];
}

const TABLE_KEYWORDS = new Set(["from", "join", "update", "into"]);
// Keywords that end a FROM clause, after which a comma no longer starts another table.
const END_FROM = new Set(
    "where group having order union intersect except limit offset fetch for window returning".split(" "),
);

function unquote(text: string): string {
    const quoted = /^([`"[])(.*)[`"\]]$/.exec(text);
    return quoted?.[2] ?? text;
}

/**
 * The tables the statement (and each subquery) around `pos` reads or writes, as name paths: those
 * after FROM, JOIN, UPDATE and INTO, and the rest of a comma-separated FROM list.
 */
export function tablesInScope(state: EditorState, pos: number): string[][] {
    const tables: string[][] = [];
    const inner = syntaxTree(state).resolveInner(pos, -1);
    for (let node: typeof inner | null = inner; node; node = node.parent) {
        if (node.name !== "Statement" && node.name !== "Parens") continue;

        let mode: "none" | "table" | "after" = "none";
        let inFrom = false;
        for (let child = node.firstChild; child; child = child.nextSibling) {
            const text = state.sliceDoc(child.from, child.to);
            if (child.name === "Keyword") {
                const word = text.toLowerCase();
                if (word === "from") inFrom = true;
                else if (END_FROM.has(word)) inFrom = false;
                if (TABLE_KEYWORDS.has(word)) mode = "table";
                else if (!(mode === "after" && word === "as")) mode = "none";
            } else if (child.name === "Identifier" || child.name === "QuotedIdentifier") {
                if (mode === "table") {
                    tables.push([unquote(text)]);
                    mode = "after";
                }
            } else if (child.name === "CompositeIdentifier") {
                if (mode === "table") {
                    const path: string[] = [];
                    for (let part = child.firstChild; part; part = part.nextSibling) {
                        if (part.name === "Identifier" || part.name === "QuotedIdentifier") {
                            path.push(unquote(state.sliceDoc(part.from, part.to)));
                        }
                    }
                    tables.push(path);
                    mode = "after";
                }
            } else if (child.name === "Punctuation" && text === ",") {
                if (inFrom) mode = "table";
            } else if (!(child.name === "Parens" && mode === "table")) {
                mode = "none";
            } else {
                // A subquery in FROM: what follows is its alias.
                mode = "after";
            }
        }
        if (node.name === "Statement") break;
    }
    return tables;
}

const SKIP_NODES = new Set(["String", "LineComment", "BlockComment", "QuotedIdentifier"]);

/**
 * Completes the columns of the tables in scope without a qualifier (`SELECT na|  FROM users`).
 * lang-sql only offers columns after `table.` or `alias.`; this leaves those, and table positions
 * (right after FROM, JOIN, …), to it.
 */
export function columnsInScope(
    namespace: SQLNamespace,
    defaultSchema: string | undefined,
    dialect: Dialect,
): CompletionSource {
    return (context: CompletionContext): CompletionResult | null => {
        const word = context.matchBefore(/[\w$]*/);
        if (!word || (word.from === word.to && !context.explicit)) return null;
        if (SKIP_NODES.has(syntaxTree(context.state).resolveInner(context.pos, -1).name)) return null;

        const before = context.state.sliceDoc(Math.max(0, word.from - 64), word.from);
        if (/\.\s*$/.test(before) || /\b(from|join|update|into|table)\s+$/i.test(before)) return null;

        const options: Completion[] = [];
        const seen = new Set<string>();
        for (const path of tablesInScope(context.state, context.pos)) {
            const table = path[path.length - 1] ?? "";
            for (const column of tableColumns(namespace, defaultSchema, path)) {
                if (seen.has(`${table}\u0000${column}`)) continue;
                seen.add(`${table}\u0000${column}`);
                options.push(identifier(column, dialect, { type: "property", detail: table, boost: 1 }));
            }
        }
        return options.length ? { from: word.from, options, validFor: /^[\w$]*$/ } : null;
    };
}
