import type { DateFormat } from "@/lib/ipc/bindings";

/**
 * Dates and times as the grid shows and edits them. PostgreSQL table sessions use `DateStyle ISO`,
 * so values arrive as `2024-05-02`, `2024-05-02 09:14:22.5+05:30`, with ` BC` for old dates and
 * `infinity` / `-infinity`. SQLite values are whatever text was stored; ISO forms (also with `T`
 * and `Z`) are understood and anything else is left alone.
 */
export interface DateParts {
    year: number;
    month: number;
    day: number;
    bc: boolean;
}

export interface DateTimeParts extends DateParts {
    /** `HH:MM:SS` with optional fraction, as written. */
    time: string;
    /** `+01`, `-05:30`, `Z`, or `null` for a value without a zone. */
    offset: string | null;
}

const DATE = /^(\d{4,})-(\d{2})-(\d{2})$/;
const DATETIME = /^(\d{4,})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2})(\.\d+)?)?(Z|[+-]\d{2}(?::?\d{2})?)?$/;

function daysIn(year: number, month: number): number {
    return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function validDate(year: number, month: number, day: number): boolean {
    return month >= 1 && month <= 12 && day >= 1 && day <= daysIn(year, month);
}

function splitBc(text: string): [string, boolean] {
    const t = text.trim();
    return t.endsWith(" BC") ? [t.slice(0, -3), true] : [t, false];
}

export function parseDate(text: string): DateParts | null {
    const [t, bc] = splitBc(text);
    const m = DATE.exec(t);
    if (!m) return null;
    const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
    return validDate(year, month, day) ? { year, month, day, bc } : null;
}

export function parseDateTime(text: string): DateTimeParts | null {
    const [t, bc] = splitBc(text);
    const m = DATETIME.exec(t);
    if (!m) return null;
    const [year, month, day, hour, minute] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5])];
    if (!validDate(year, month, day) || hour > 24 || minute > 59 || Number(m[6] ?? 0) > 60) return null;
    const time = `${m[4]}:${m[5]}:${m[6] ?? "00"}${m[7] ?? ""}`;
    return { year, month, day, bc, time, offset: m[8] ?? null };
}

const pad = (n: number, width = 2) => String(n).padStart(width, "0");

export function formatDate(parts: DateParts): string {
    return `${pad(parts.year, 4)}-${pad(parts.month)}-${pad(parts.day)}${parts.bc ? " BC" : ""}`;
}

/** ISO text with a space between date and time, which both engines read. */
export function formatDateTime(parts: DateTimeParts): string {
    const date = `${pad(parts.year, 4)}-${pad(parts.month)}-${pad(parts.day)}`;
    return `${date} ${parts.time}${parts.offset ?? ""}${parts.bc ? " BC" : ""}`;
}

/** Whether `HH:MM`, `HH:MM:SS` or `HH:MM:SS.ffffff` is a time of day. */
export function validTime(text: string): boolean {
    const m = /^(\d{2}):(\d{2})(?::(\d{2})(\.\d{1,6})?)?$/.exec(text);
    return !!m && Number(m[1]) <= 24 && Number(m[2]) <= 59 && Number(m[3] ?? 0) <= 60;
}

/** A UTC offset as PostgreSQL writes it: `+01`, `-05:30`, or `Z`. */
export function validOffset(text: string): boolean {
    return text === "Z" || /^[+-]\d{2}(:?\d{2})?$/.test(text);
}

/**
 * A date or datetime value for display. ISO shows the database's text; Locale uses the system's
 * date format for the same wall-clock fields (no time zone conversion), keeping the offset.
 */
export function displayDate(text: string, kind: "date" | "datetime", format: DateFormat): string {
    if (format === "iso") return text;
    const timed = kind === "datetime" ? parseDateTime(text) : null;
    const parts = kind === "date" ? parseDate(text) : timed;
    if (!parts || parts.bc || parts.year > 9999) return text;
    const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
    date.setUTCFullYear(parts.year);
    const day = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeZone: "UTC" }).format(date);
    if (!timed) return day;
    return `${day} ${timed.time}${timed.offset ? ` ${timed.offset}` : ""}`;
}

/** Today in the local calendar. */
export function today(): DateParts {
    const now = new Date();
    return { year: now.getFullYear(), month: now.getMonth() + 1, day: now.getDate(), bc: false };
}

/** Days of a month view starting on Monday: leading days of the previous month and trailing days of the next. */
export function monthGrid(year: number, month: number): { year: number; month: number; day: number }[] {
    const first = new Date(Date.UTC(year, month - 1, 1));
    first.setUTCFullYear(year);
    const lead = (first.getUTCDay() + 6) % 7;
    const days: { year: number; month: number; day: number }[] = [];
    for (let i = 0; i < 42; i++) {
        const d = new Date(first.getTime());
        d.setUTCDate(1 - lead + i);
        days.push({ year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() });
    }
    // Drop a last week that is wholly in the next month.
    return days.slice(35).every((d) => d.month !== month) ? days.slice(0, 35) : days;
}
