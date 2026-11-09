import { ChevronLeft, ChevronRight } from "lucide-react";
import { type KeyboardEvent, useEffect, useRef, useState } from "react";

import { type DateParts, monthGrid, parseDate, parseDateTime, today } from "@/lib/grid/dates";

import styles from "@/components/ui/DatePicker.module.css";

interface CalendarProps {
    selected: DateParts | null;
    onPick: (day: DateParts, commit: boolean) => void;
}

const MONTHS = new Intl.DateTimeFormat("en", { month: "long", year: "numeric", timeZone: "UTC" });
const WEEKDAYS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];

function shift(day: { year: number; month: number; day: number }, days: number, months = 0) {
    const d = new Date(Date.UTC(day.year, day.month - 1 + months, 1));
    d.setUTCFullYear(day.year);
    d.setUTCMonth(day.month - 1 + months);
    const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
    d.setUTCDate(Math.min(day.day, last) + days);
    return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

/** A month calendar for picking a day. */
export function Calendar({ selected, onPick }: CalendarProps) {
    const start = selected ?? today();
    const [focus, setFocus] = useState({ year: start.year, month: start.month, day: start.day });
    const gridRef = useRef<HTMLDivElement>(null);
    const focusInside = useRef(false);

    // Follow the typed value.
    useEffect(() => {
        if (selected) setFocus({ year: selected.year, month: selected.month, day: selected.day });
    }, [selected?.year, selected?.month, selected?.day, selected]);

    useEffect(() => {
        if (focusInside.current) gridRef.current?.querySelector<HTMLElement>('[tabindex="0"]')?.focus();
    });

    const days = monthGrid(focus.year, focus.month);
    const same = (
        a: { year: number; month: number; day: number } | null,
        b: { year: number; month: number; day: number },
    ) => !!a && a.year === b.year && a.month === b.month && a.day === b.day;
    const now = today();

    const onKeyDown = (e: KeyboardEvent) => {
        const months = e.shiftKey ? 12 : 1;
        const by: Record<string, [number, number]> = {
            ArrowLeft: [-1, 0],
            ArrowRight: [1, 0],
            ArrowUp: [-7, 0],
            ArrowDown: [7, 0],
            PageUp: [0, -months],
            PageDown: [0, months],
        };
        const step = by[e.key];
        const move = step ? () => shift(focus, step[0], step[1]) : null;
        if (move) {
            e.preventDefault();
            e.stopPropagation();
            focusInside.current = true;
            setFocus(move());
        } else if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            e.stopPropagation();
            onPick({ ...focus, bc: selected?.bc ?? false }, e.key === "Enter");
        }
    };

    return (
        <div className={styles.calendar}>
            <div className={styles.header}>
                <span className={styles.month} aria-live="polite">
                    {MONTHS.format(new Date(Date.UTC(focus.year, focus.month - 1, 1)))}
                </span>
                <button
                    type="button"
                    className={styles.nav}
                    aria-label="Previous month"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => setFocus(shift(focus, 0, -1))}
                >
                    <ChevronLeft size={14} />
                </button>
                <button
                    type="button"
                    className={styles.nav}
                    aria-label="Next month"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => setFocus(shift(focus, 0, 1))}
                >
                    <ChevronRight size={14} />
                </button>
            </div>
            <div className={styles.weekdays} aria-hidden>
                {WEEKDAYS.map((d) => (
                    <span key={d}>{d}</span>
                ))}
            </div>
            {/* biome-ignore lint/a11y/useSemanticElements: a day grid with roving focus, as the ARIA date picker pattern uses */}
            <div
                ref={gridRef}
                className={styles.days}
                role="grid"
                aria-label="Days"
                onKeyDown={onKeyDown}
                onFocus={() => {
                    focusInside.current = true;
                }}
                onBlur={() => {
                    focusInside.current = false;
                }}
            >
                {Array.from({ length: days.length / 7 }, (_, w) => (
                    // biome-ignore lint/a11y/useSemanticElements: see above
                    // biome-ignore lint/a11y/useFocusableInteractive: days take focus
                    // biome-ignore lint/suspicious/noArrayIndexKey: weeks have no identity
                    <div key={w} role="row" className={styles.week}>
                        {days.slice(w * 7, w * 7 + 7).map((d) => {
                            const isFocus = same(focus, d);
                            return (
                                // biome-ignore lint/a11y/useSemanticElements: grid cells of the day grid
                                <div
                                    key={`${d.year}-${d.month}-${d.day}`}
                                    role="gridcell"
                                    tabIndex={isFocus ? 0 : -1}
                                    aria-selected={same(selected, d)}
                                    aria-label={new Date(Date.UTC(d.year, d.month - 1, d.day)).toDateString()}
                                    className={styles.day}
                                    data-outside={d.month !== focus.month || undefined}
                                    data-selected={same(selected, d) || undefined}
                                    data-today={same(now, d) || undefined}
                                    onMouseDown={(e) => e.preventDefault()}
                                    onClick={() => onPick({ ...d, bc: false }, false)}
                                    onDoubleClick={() => onPick({ ...d, bc: false }, true)}
                                    onKeyDown={() => {}}
                                >
                                    {d.day}
                                </div>
                            );
                        })}
                    </div>
                ))}
            </div>
        </div>
    );
}

/** The date part of a date or datetime text, for the calendar. */
export function selectedDay(text: string, kind: "date" | "datetime"): DateParts | null {
    return kind === "date" ? parseDate(text) : (parseDateTime(text) ?? parseDate(text.slice(0, 10)));
}
