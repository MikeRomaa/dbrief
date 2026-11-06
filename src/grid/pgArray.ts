/** A PostgreSQL array value: elements are text, NULL, or nested arrays. */
export type PgArray = (string | null | PgArray)[];

/**
 * Parses PostgreSQL's array text output (`{1,2}`, `{"a b",NULL,"say \"hi\""}`, `{{1,2},{3,4}}`,
 * optionally with `[1:2]=` bounds). Returns `null` when the text isn't an array literal.
 */
export function parsePgArray(text: string): PgArray | null {
    let s = text.trim();
    const bounds = /^(\[\d+:\d+\])+=/.exec(s);
    if (bounds) s = s.slice(bounds[0].length);
    if (!s.startsWith("{")) return null;

    let i = 0;
    const parseArray = (): PgArray | null => {
        if (s[i] !== "{") return null;
        i++;
        const items: PgArray = [];
        if (s[i] === "}") {
            i++;
            return items;
        }
        while (i < s.length) {
            if (s[i] === "{") {
                const inner = parseArray();
                if (!inner) return null;
                items.push(inner);
            } else if (s[i] === '"') {
                i++;
                let value = "";
                while (i < s.length && s[i] !== '"') {
                    if (s[i] === "\\") i++;
                    value += s[i] ?? "";
                    i++;
                }
                if (s[i] !== '"') return null;
                i++;
                items.push(value);
            } else {
                let value = "";
                while (i < s.length && s[i] !== "," && s[i] !== "}") {
                    value += s[i];
                    i++;
                }
                const trimmed = value.trim();
                items.push(trimmed.toUpperCase() === "NULL" ? null : trimmed);
            }
            if (s[i] === ",") {
                i++;
            } else if (s[i] === "}") {
                i++;
                return items;
            } else {
                return null;
            }
        }
        return null;
    };

    const result = parseArray();
    return result && i === s.length ? result : null;
}

/** Whether a database type name is an array type (`_int4`, `int4[]`, `text[]`). */
export function isArrayType(typeName: string): boolean {
    return typeName.startsWith("_") || typeName.endsWith("[]");
}
