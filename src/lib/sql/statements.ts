/**
 * Splits SQL scripts into statements and finds query parameters, following each dialect's lexical
 * rules so semicolons and placeholders inside strings, quoted identifiers, comments and dollar-quoted
 * bodies are ignored. The backend runs one statement at a time; this is the only splitter.
 */

export type Dialect = "postgres" | "sqlite";

/**
 * One statement. `from`–`to` is its text without surrounding whitespace or the closing semicolon;
 * `end` is just past the semicolon (or `to` when there is none), for matching the cursor.
 */
export interface Statement {
    from: number;
    to: number;
    end: number;
    text: string;
}

/** A query parameter: `?1` (numbered), `:name` (named) or `%(name)s` (pyformat). */
export interface Placeholder {
    from: number;
    to: number;
    key: string;
}

type Region = { kind: "code" | "skip"; from: number; to: number };

const IDENT_START = /[A-Za-z_]/;
const IDENT = /[A-Za-z0-9_]/;

/** Where a `$tag$` opening at `i` ends, or -1 when it isn't one (`$1` is a parameter, not a tag). */
function dollarTagEnd(sql: string, i: number): number {
    let j = i + 1;
    if (sql[j] === "$") return j + 1;
    if (!IDENT_START.test(sql[j] ?? "")) return -1;
    while (IDENT.test(sql[j] ?? "")) j++;
    return sql[j] === "$" ? j + 1 : -1;
}

/**
 * Walks the text and yields code and skipped regions (strings, identifiers, comments, dollar bodies).
 * An unterminated region runs to the end of the text.
 */
function regions(sql: string, dialect: Dialect): Region[] {
    const out: Region[] = [];
    const n = sql.length;
    let codeFrom = 0;
    let i = 0;

    const skip = (from: number, to: number) => {
        if (from > codeFrom) out.push({ kind: "code", from: codeFrom, to: from });
        out.push({ kind: "skip", from, to });
        codeFrom = to;
        i = to;
    };

    /** Index just past a closing `quote`, where a doubled quote is an escaped one. */
    const closeQuoted = (start: number, quote: string, backslash: boolean): number => {
        let j = start;
        while (j < n) {
            const c = sql[j];
            if (backslash && c === "\\") {
                j += 2;
            } else if (c === quote) {
                if (sql[j + 1] === quote) j += 2;
                else return j + 1;
            } else {
                j++;
            }
        }
        return n;
    };

    while (i < n) {
        const c = sql[i];
        const next = sql[i + 1];

        if (c === "-" && next === "-") {
            const eol = sql.indexOf("\n", i);
            skip(i, eol === -1 ? n : eol);
        } else if (c === "/" && next === "*") {
            // PostgreSQL comments nest; SQLite's end at the first */.
            let depth = 1;
            let j = i + 2;
            while (j < n && depth > 0) {
                if (sql[j] === "*" && sql[j + 1] === "/") {
                    depth--;
                    j += 2;
                } else if (dialect === "postgres" && sql[j] === "/" && sql[j + 1] === "*") {
                    depth++;
                    j += 2;
                } else {
                    j++;
                }
            }
            skip(i, j);
        } else if (c === "'") {
            const escaped =
                dialect === "postgres" && (sql[i - 1] === "E" || sql[i - 1] === "e") && !IDENT.test(sql[i - 2] ?? "");
            skip(escaped ? i - 1 : i, closeQuoted(i + 1, "'", escaped));
        } else if (c === '"') {
            skip(i, closeQuoted(i + 1, '"', false));
        } else if (dialect === "sqlite" && c === "`") {
            skip(i, closeQuoted(i + 1, "`", false));
        } else if (dialect === "sqlite" && c === "[") {
            const close = sql.indexOf("]", i + 1);
            skip(i, close === -1 ? n : close + 1);
        } else if (dialect === "postgres" && c === "$" && !IDENT.test(sql[i - 1] ?? "")) {
            const tagEnd = dollarTagEnd(sql, i);
            if (tagEnd === -1) {
                i++;
            } else {
                const tag = sql.slice(i, tagEnd);
                const close = sql.indexOf(tag, tagEnd);
                skip(i, close === -1 ? n : close + tag.length);
            }
        } else {
            i++;
        }
    }

    if (codeFrom < n) out.push({ kind: "code", from: codeFrom, to: n });
    return out;
}

/** True when the text has something besides whitespace and comments. */
function hasCode(sql: string, dialect: Dialect): boolean {
    return regions(sql, dialect).some((r) => {
        const text = sql.slice(r.from, r.to);
        return r.kind === "code" ? text.trim() !== "" : !text.startsWith("--") && !text.startsWith("/*");
    });
}

/** The statements in a script, in order. Comment-only stretches between statements are not statements. */
export function splitStatements(sql: string, dialect: Dialect): Statement[] {
    const statements: Statement[] = [];
    let start = 0;

    const push = (to: number, end: number) => {
        const raw = sql.slice(start, to);
        const lead = raw.length - raw.trimStart().length;
        const text = raw.trim();
        if (text && hasCode(text, dialect)) {
            const from = start + lead;
            statements.push({ from, to: from + text.length, end, text });
        }
    };

    for (const region of regions(sql, dialect)) {
        if (region.kind !== "code") continue;

        for (let i = region.from; i < region.to; i++) {
            if (sql[i] === ";") {
                push(i, i + 1);
                start = i + 1;
            }
        }
    }

    push(sql.length, sql.length);
    return statements;
}

/**
 * The statement to run for a cursor at `pos`: the one containing it, else the closest one before it
 * (cursor after a statement's semicolon), else the first one after it.
 */
export function statementAt(statements: Statement[], pos: number): Statement | undefined {
    const containing = statements.find((s) => pos >= s.from && pos <= s.end);
    if (containing) return containing;

    const before = statements.filter((s) => s.end <= pos).pop();
    return before ?? statements.find((s) => s.from >= pos);
}

/** The statements a selection touches, for running a selection that spans several. */
export function statementsIn(statements: Statement[], from: number, to: number): Statement[] {
    return statements.filter((s) => s.to > from && s.from < to);
}

/** Placeholders in a statement, outside strings, identifiers and comments. */
export function findPlaceholders(sql: string, dialect: Dialect): Placeholder[] {
    const found: Placeholder[] = [];

    for (const region of regions(sql, dialect)) {
        if (region.kind !== "code") continue;

        const code = sql.slice(region.from, region.to);
        const pattern = /\?(\d+)|(?<![:\w]):([A-Za-z_]\w*)(?!:)|%\(([A-Za-z_]\w*)\)s/g;
        for (const m of code.matchAll(pattern)) {
            const key = m[1] ?? m[2] ?? m[3];
            if (key === undefined || m.index === undefined) continue;

            const from = region.from + m.index;
            found.push({ from, to: from + m[0].length, key });
        }
    }

    return found;
}

/** A value as a SQL string literal: single quotes doubled, so it can't end the literal early. */
export function quoteLiteral(value: string): string {
    return `'${value.replaceAll("'", "''")}'`;
}

/** The distinct placeholder keys in order of first appearance, for the parameters prompt. */
export function placeholderKeys(sql: string, dialect: Dialect): string[] {
    return [...new Set(findPlaceholders(sql, dialect).map((p) => p.key))];
}

/**
 * Replaces each placeholder with its value as a quoted literal (`null` gives NULL), as `psql` does
 * for `:'name'`. Quoted literals have no fixed type, so PostgreSQL converts them from context
 * (`id = '42'`) and SQLite applies column affinity. Keys missing from `values` are left as typed.
 */
export function fillPlaceholders(sql: string, dialect: Dialect, values: Record<string, string | null>): string {
    let out = "";
    let last = 0;

    for (const p of findPlaceholders(sql, dialect)) {
        if (!(p.key in values)) continue;

        const value = values[p.key];
        out += sql.slice(last, p.from) + (value === null || value === undefined ? "NULL" : quoteLiteral(value));
        last = p.to;
    }

    return out + sql.slice(last);
}
