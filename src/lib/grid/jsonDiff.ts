/** Above this many line pairs, lines are compared by position instead of by a full diff. */
const DIFF_LIMIT = 1_000_000;

/**
 * The 1-based numbers of the lines in `after` that aren't in `before`: lines added or changed,
 * from a longest-common-subsequence diff of the two.
 */
export function changedLines(before: string[], after: string[]): number[] {
    const n = before.length;
    const m = after.length;
    if (n * m > DIFF_LIMIT) {
        return after.flatMap((line, i) => (before[i] === line ? [] : [i + 1]));
    }

    // at(i, j): the longest common subsequence of before[i..] and after[j..].
    const lcs = new Uint32Array((n + 1) * (m + 1));
    const at = (i: number, j: number) => lcs[i * (m + 1) + j] ?? 0;
    for (let i = n - 1; i >= 0; i--) {
        for (let j = m - 1; j >= 0; j--) {
            lcs[i * (m + 1) + j] = before[i] === after[j] ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1));
        }
    }
    const changed: number[] = [];
    let i = 0;
    let j = 0;
    while (j < m) {
        if (i < n && before[i] === after[j]) {
            i++;
            j++;
        } else if (i < n && at(i + 1, j) >= at(i, j + 1)) {
            i++;
        } else {
            changed.push(j + 1);
            j++;
        }
    }
    return changed;
}

/**
 * One changed value in a JSON document. `path` is how it is reached (`seats`, `regions[1]`,
 * `owner.name`); `before` or `after` is `undefined` when the value was added or removed.
 */
export interface JsonChange {
    path: string;
    before: unknown;
    after: unknown;
}

function isObject(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function same(a: unknown, b: unknown): boolean {
    return JSON.stringify(a) === JSON.stringify(b);
}

function join(path: string, key: string | number): string {
    if (typeof key === "number") return `${path}[${key}]`;
    const name = /^[A-Za-z_$][\w$]*$/.test(key) ? key : JSON.stringify(key);
    return path ? `${path}.${name}` : name;
}

/**
 * The values that differ between two JSON documents, deepest first where both sides are objects
 * or arrays: a changed key inside an object is listed by its own path, not as a change of the
 * whole object. A changed root (or a root of another kind) is listed with the path `$`.
 */
export function jsonChanges(before: unknown, after: unknown, path = ""): JsonChange[] {
    if (same(before, after)) return [];
    if (isObject(before) && isObject(after)) {
        const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])];
        return keys.flatMap((k) =>
            k in before && k in after
                ? jsonChanges(before[k], after[k], join(path, k))
                : [{ path: join(path, k), before: before[k], after: after[k] }],
        );
    }
    if (Array.isArray(before) && Array.isArray(after)) {
        const length = Math.max(before.length, after.length);
        return Array.from({ length }, (_, i) =>
            i < before.length && i < after.length
                ? jsonChanges(before[i], after[i], join(path, i))
                : [{ path: join(path, i), before: before[i], after: after[i] }],
        ).flat();
    }
    return [{ path: path || "$", before, after }];
}
