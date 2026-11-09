/**
 * How well `query` matches `text`, case-insensitively: `null` unless every query character appears in
 * order. Exact matches score highest, then prefixes, then matches at word starts (after `_`, `.`,
 * space, `-`, `/` or a lowercase-to-uppercase change) and runs of consecutive characters. Shorter
 * texts win ties. Matches `fuzzy_score` in `dbrief-core::schema::cache`, which ranks tables and
 * columns.
 */
export function fuzzyScore(query: string, text: string): number | null {
    if (query === "") return 0;
    const q = [...query.toLowerCase()];
    const original = [...text];
    const t = [...text.toLowerCase()];
    if (t.length !== original.length) {
        return text.toLowerCase().includes(query.toLowerCase()) ? 1 : null;
    }
    if (q.join("") === t.join("")) return Math.floor(2147483647 / 2);

    let score = 0;
    let qi = 0;
    let previous = -2;
    for (let ti = 0; ti < t.length && qi < q.length; ti++) {
        if (t[ti] !== q[qi]) continue;
        const before = original[ti - 1];
        const current = original[ti] ?? "";
        const wordStart =
            ti === 0 ||
            "_. -/".includes(t[ti - 1] ?? "") ||
            (before !== undefined && isLower(before) && isUpper(current));
        score += 1;
        if (wordStart) score += 8;
        if (previous === ti - 1) score += 5;
        previous = ti;
        qi++;
    }
    if (qi < q.length) return null;

    if (t.join("").startsWith(q.join(""))) score += 100;
    return score * 10 - Math.min(t.length, 100);
}

const isLower = (c: string) => c !== c.toUpperCase() && c === c.toLowerCase();
const isUpper = (c: string) => c !== c.toLowerCase() && c === c.toUpperCase();

/** The items matching `query`, best first, at most `limit`. */
export function rank<T>(items: Iterable<T>, query: string, text: (item: T) => string, limit: number): T[] {
    const scored: { item: T; score: number; text: string }[] = [];
    for (const item of items) {
        const t = text(item);
        const score = fuzzyScore(query, t);
        if (score !== null) scored.push({ item, score, text: t });
    }
    scored.sort((a, b) => b.score - a.score || a.text.localeCompare(b.text));
    return scored.slice(0, limit).map((s) => s.item);
}
