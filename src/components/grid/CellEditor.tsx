import { useEffect, useId, useRef, useState } from "react";

import { Calendar, selectedDay } from "@/components/ui/DatePicker";
import { formatDate, formatDateTime, parseDateTime, today } from "@/lib/grid/dates";
import { type EditorSpec, validate } from "@/lib/grid/editors";

import styles from "@/components/grid/CellEditor.module.css";

/** Where the focus goes after saving: Enter moves down, Tab right, Shift-Tab left. */
export type EditorMove = "down" | "right" | "left" | "none";

interface CellEditorProps {
    spec: EditorSpec;
    left: number;
    top: number;
    width: number;
    height: number;
    /**
     * `text` is `null` for NULL, and `undefined` when the value wasn't changed (only move). `all`
     * saves into every selected cell (⌘⏎).
     */
    onCommit: (text: string | null | undefined, move: EditorMove, all: boolean) => void;
    onCancel: () => void;
}

const sameText = (a: string, b: string) => a.replace(/\r\n?/g, "\n") === b.replace(/\r\n?/g, "\n");

/** Lines a multi-line value shows before the editor scrolls. */
const MAX_LINES = 12;
const LINE_HEIGHT = 18;

/**
 * The editor over a grid cell: a text area for text and JSON (it grows with line breaks; Shift-Enter
 * or Option-Enter adds one), a text input for numbers, with a calendar under it for dates. The value
 * is checked before it is saved; a problem shows under the input and keeps it open.
 */
export function CellEditor({ spec, left, top, width, height, onCommit, onCancel }: CellEditorProps) {
    const [text, setText] = useState(spec.initial);
    const [loading, setLoading] = useState(!!spec.load);
    const [error, setError] = useState<string | null>(null);
    const inputRef = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
    const done = useRef(false);
    // The value the editor opened with, whole (after loading), to tell an unchanged save apart.
    const original = useRef(spec.initial);
    const errorId = useId();
    const isDate = spec.kind === "date" || spec.kind === "datetime";
    const area = spec.kind === "text" || spec.kind === "json";

    // biome-ignore lint/correctness/useExhaustiveDependencies: loads once, for the cell the editor opened on
    useEffect(() => {
        if (!spec.load) return;
        let cancelled = false;
        spec.load()
            .then((full) => {
                if (cancelled) return;
                original.current = full;
                setText(full);
                setLoading(false);
            })
            .catch((e: unknown) => {
                if (cancelled) return;
                setError(`Could not load the value: ${e instanceof Error ? e.message : String(e)}`);
            });
        return () => {
            cancelled = true;
        };
    }, []);

    useEffect(() => {
        const input = inputRef.current;
        if (!input || loading) return;
        input.focus();
        // Typing a character starts a fresh value; Enter or F2 keeps the old one, cursor at the end.
        input.setSelectionRange(input.value.length, input.value.length);
    }, [loading]);

    const lines = area ? Math.min(text.split("\n").length, MAX_LINES) : 1;
    const boxHeight = lines > 1 ? lines * LINE_HEIGHT + 8 : height;
    const boxWidth = Math.max(width, isDate ? 200 : lines > 1 ? 360 : 120);

    const commit = (move: EditorMove, all: boolean, value: string | null = text) => {
        if (loading) return false;
        // A text area writes line breaks as \n, so a \r\n value only looks changed.
        const unchanged = !spec.replaced && value !== null && sameText(value, original.current);
        if (unchanged) {
            done.current = true;
            onCommit(all ? original.current : undefined, move, all);
            return true;
        }
        if (value !== null) {
            const problem = validate(spec.kind, value, spec.typeName, spec.engine);
            if (problem) {
                setError(problem);
                return false;
            }
        }
        done.current = true;
        onCommit(value, move, all);
        return true;
    };

    const pickDay = (day: { year: number; month: number; day: number; bc: boolean }, save: boolean) => {
        let next: string;
        if (spec.kind === "date") {
            next = formatDate(day);
        } else {
            const current = parseDateTime(text);
            next = formatDateTime({
                ...day,
                time: current?.time ?? "00:00:00",
                offset: current?.offset ?? (spec.timeZone ? "+00" : null),
            });
        }
        setText(next);
        setError(null);
        if (save) commit("none", false, next);
    };

    const Field = area ? "textarea" : "input";

    return (
        <>
            <Field
                ref={inputRef}
                className={styles.input}
                data-area={area || undefined}
                data-multiline={lines > 1 || undefined}
                style={{ left, top, width: boxWidth, height: boxHeight }}
                value={loading ? "Loading…" : text}
                readOnly={loading}
                rows={area ? 1 : undefined}
                spellCheck={false}
                aria-label={`Edit ${spec.label}`}
                aria-invalid={!!error || undefined}
                aria-describedby={error ? errorId : undefined}
                onChange={(e) => {
                    setText(e.target.value);
                    setError(null);
                }}
                onKeyDown={(e) => {
                    e.stopPropagation();
                    const mod = e.metaKey || e.ctrlKey;
                    if (e.key === "Escape") {
                        e.preventDefault();
                        done.current = true;
                        onCancel();
                    } else if (e.key === "Enter" && area && (e.shiftKey || e.altKey) && !mod) {
                        // A line break: Shift-Enter types one; Option-Enter is inserted by hand.
                        if (e.altKey) {
                            e.preventDefault();
                            const el = e.currentTarget;
                            const a = el.selectionStart ?? text.length;
                            const b = el.selectionEnd ?? a;
                            setText(`${text.slice(0, a)}\n${text.slice(b)}`);
                            setError(null);
                            requestAnimationFrame(() => el.setSelectionRange(a + 1, a + 1));
                        }
                    } else if (e.key === "Enter") {
                        e.preventDefault();
                        commit(mod ? "none" : "down", mod);
                    } else if (e.key === "Tab") {
                        e.preventDefault();
                        commit(e.shiftKey ? "left" : "right", false);
                    }
                }}
                onBlur={() => {
                    if (done.current) return;
                    if (loading) {
                        done.current = true;
                        onCancel();
                        return;
                    }
                    if (!commit("none", false)) {
                        done.current = true;
                        onCancel();
                    }
                }}
            />
            {error && (
                <div id={errorId} className={styles.error} style={{ left, top: top + boxHeight }} role="alert">
                    {error}
                </div>
            )}
            {isDate && !error && (
                <div className={styles.popover} style={{ left, top: top + height + 2 }}>
                    <Calendar selected={selectedDay(text, spec.kind as "date" | "datetime")} onPick={pickDay} />
                    <div className={styles.footer}>
                        <button
                            type="button"
                            className={styles.action}
                            onMouseDown={(e) => e.preventDefault()}
                            onClick={() => pickDay(today(), false)}
                        >
                            Today
                        </button>
                        {spec.nullable && (
                            <button
                                type="button"
                                className={styles.action}
                                data-muted
                                onMouseDown={(e) => e.preventDefault()}
                                onClick={() => commit("none", false, null)}
                            >
                                NULL
                            </button>
                        )}
                        <span className={styles.hint}>
                            {spec.kind === "datetime" ? "Time: HH:MM:SS" : ""} ⏎ to save
                        </span>
                    </div>
                </div>
            )}
        </>
    );
}
