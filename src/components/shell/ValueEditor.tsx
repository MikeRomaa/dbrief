import { save as chooseSaveFile } from "@tauri-apps/plugin-dialog";
import {
    ArrowDown,
    ArrowRight,
    ArrowUp,
    Check,
    Download,
    Plus,
    RotateCcw,
    TriangleAlert,
    Upload,
    X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { JsonCode } from "@/components/shell/JsonCode";
import { Segmented } from "@/components/ui/Segmented";
import { looksLikeJson, validate } from "@/lib/grid/editors";
import type { InspectorEdit } from "@/lib/grid/inspector";
import { type JsonChange, jsonChanges } from "@/lib/grid/jsonDiff";
import { type PgArray, parsePgArray, serializePgArray } from "@/lib/grid/pgArray";
import type { FullValue } from "@/lib/ipc/bindings";
import { formatBytes } from "@/lib/util/numbers";

import styles from "@/components/shell/InspectorPanel.module.css";
import controls from "@/components/ui/controls.module.css";

/**
 * The inspector's editor for one cell's full value: text, JSON (JSON / Tree / Raw), an array as a
 * list, or a binary value (upload, download, NULL). `value` is the value before any staged change;
 * Save (⌘⏎) stages the edit, Revert cell drops it.
 *
 * A text value that holds a JSON object or array opens in the JSON editor too, with a Text view: it
 * is still text, so JSON is only checked while a JSON view is shown.
 */
interface ValueEditorProps {
    edit: InspectorEdit;
    value: FullValue | null;
    onSaveToFile: (() => void) | null;
}

function startText(edit: InspectorEdit, value: FullValue | null): string | null {
    const staged = edit.staged;
    if (staged?.kind === "text") return staged.text;
    if (staged?.kind === "null" || staged?.kind === "default") return null;
    if (value?.null) return null;
    return value?.text ?? null;
}

export function ValueEditor({ edit, value, onSaveToFile }: ValueEditorProps) {
    if (edit.kind === "binary") return <BinaryEditor edit={edit} value={value} onSaveToFile={onSaveToFile} />;
    if (edit.kind === "json") return <JsonEditor edit={edit} value={value} />;
    if (edit.kind === "text") {
        const text = startText(edit, value);
        if (text !== null && looksLikeJson(text)) return <JsonEditor edit={edit} value={value} detected />;
    }
    if (edit.kind === "array") {
        const text = startText(edit, value);
        const items = text === null ? [] : parsePgArray(text);
        if (items?.every((i) => !Array.isArray(i))) return <ArrayEditor edit={edit} start={text} items={items} />;
    }
    return <TextEditor edit={edit} value={value} />;
}

function StagedNote({ edit }: { edit: InspectorEdit }) {
    if (!edit.staged) return null;
    const what =
        edit.staged.kind === "null"
            ? "Set to NULL"
            : edit.staged.kind === "default"
              ? "Set to DEFAULT"
              : edit.staged.kind === "file"
                ? `Uploaded file, ${formatBytes(edit.staged.size)}`
                : edit.staged.kind === "original"
                  ? "Copied from another row"
                  : "Edited";
    return <p className={styles.staged}>{what} · staged</p>;
}

function Footer({
    edit,
    canSave,
    onSave,
    extra,
}: {
    edit: InspectorEdit;
    canSave: boolean;
    onSave: () => void;
    extra?: React.ReactNode;
}) {
    return (
        <div className={styles.footer}>
            {extra}
            {edit.nullable && (
                <button type="button" className={controls.ghost} onClick={() => edit.stage({ kind: "null" })}>
                    Set NULL
                </button>
            )}
            <span className={styles.spacer} />
            <button type="button" className={controls.button} disabled={!edit.staged} onClick={edit.revert}>
                <RotateCcw size={12} />
                Revert cell
            </button>
            <button type="button" className={controls.primary} disabled={!canSave} onClick={onSave}>
                Save
            </button>
        </div>
    );
}

function TextEditor({ edit, value }: { edit: InspectorEdit; value: FullValue | null }) {
    const start = startText(edit, value);
    const [text, setText] = useState(start ?? "");
    const [touched, setTouched] = useState(false);
    // biome-ignore lint/correctness/useExhaustiveDependencies: a new cell or staged value restarts the editor
    useEffect(() => {
        setText(start ?? "");
        setTouched(false);
    }, [start, edit.staged]);

    const problem = touched ? validate(edit.kind, text, edit.typeName, edit.engine) : null;
    const save = () => {
        if (!problem) edit.stage({ kind: "text", text });
    };

    return (
        <>
            <StagedNote edit={edit} />
            {start === null && !touched && (
                <p className={styles.null}>
                    {edit.staged?.kind === "default" || (!edit.staged && edit.defaultText)
                        ? `DEFAULT${edit.defaultText ? ` (${edit.defaultText})` : ""}`
                        : "NULL"}
                </p>
            )}
            <textarea
                className={styles.textarea}
                value={text}
                spellCheck={false}
                aria-label="Value"
                aria-invalid={!!problem || undefined}
                rows={8}
                onChange={(e) => {
                    setText(e.target.value);
                    setTouched(true);
                }}
                onKeyDown={(e) => {
                    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                        e.preventDefault();
                        save();
                    }
                }}
            />
            {problem ? (
                <p className={styles.invalid} role="alert">
                    <TriangleAlert size={12} /> {problem}
                </p>
            ) : (
                <p className={styles.meta}>{[...text].length.toLocaleString("en-US")} characters · ⌘⏎ to save</p>
            )}
            <Footer edit={edit} canSave={touched && !problem} onSave={save} />
        </>
    );
}

type JsonView = "json" | "tree" | "raw" | "text";
const JSON_VIEWS = [
    { value: "json", label: "JSON" },
    { value: "tree", label: "Tree" },
    { value: "raw", label: "Raw" },
] as const;
const DETECTED_VIEWS = [...JSON_VIEWS, { value: "text", label: "Text" }] as const;

function pretty(text: string): string {
    try {
        return JSON.stringify(JSON.parse(text), null, 2);
    } catch {
        return text;
    }
}

/**
 * `detected` marks a text column whose value looks like JSON: the Text view saves anything, and the
 * JSON view writes the value back in the layout it had (indented if it was on several lines).
 */
function JsonEditor({
    edit,
    value,
    detected = false,
}: {
    edit: InspectorEdit;
    value: FullValue | null;
    detected?: boolean;
}) {
    const start = startText(edit, value);
    const [view, setView] = useState<JsonView>("json");
    const [text, setText] = useState(pretty(start ?? ""));
    const [touched, setTouched] = useState(false);
    // biome-ignore lint/correctness/useExhaustiveDependencies: a new cell or staged value restarts the editor
    useEffect(() => {
        setText(view === "raw" || view === "text" ? (start ?? "") : pretty(start ?? ""));
        setTouched(false);
    }, [start, edit.staged]);

    const { parsed, parseError } = useMemo(() => {
        try {
            return { parsed: JSON.parse(text) as unknown, parseError: null };
        } catch (e) {
            return { parsed: undefined, parseError: e instanceof Error ? e.message : String(e) };
        }
    }, [text]);
    // The Text view of a text column takes any text.
    const problem = view === "text" ? null : parseError;
    const empty = text.trim() === "" && start === null;

    // What the value was before any staged change, laid out like the current view, so the lines
    // and values that differ from it can be marked.
    const original = value && !value.null ? (value.text ?? null) : null;
    const originalParsed = useMemo(() => parseJson(original), [original]);
    const baseline =
        original === null
            ? null
            : view === "text" || originalParsed === undefined
              ? original
              : view === "raw"
                ? JSON.stringify(originalParsed)
                : JSON.stringify(originalParsed, null, 2);
    const changes = useMemo(
        () =>
            baseline === null || originalParsed === undefined || parseError ? [] : jsonChanges(originalParsed, parsed),
        [baseline, originalParsed, parsed, parseError],
    );

    const switchView = (next: JsonView) => {
        if (next === "text") {
            // Untouched, Text shows the value exactly as stored.
            if (!touched) setText(start ?? "");
        } else if (!parseError) {
            setText(next === "raw" ? JSON.stringify(parsed) : JSON.stringify(parsed, null, 2));
        }
        setView(next);
    };
    const save = () => {
        if (problem) return;
        if (view === "text" || view === "raw") return edit.stage({ kind: "text", text });
        // A JSON column stores the value compactly; the JSON view's indentation is only for reading.
        // A text column keeps the layout its value had.
        const indented = detected && /\n/.test(start ?? "");
        edit.stage({ kind: "text", text: indented ? JSON.stringify(parsed, null, 2) : JSON.stringify(parsed) });
    };

    return (
        <>
            <StagedNote edit={edit} />
            {detected && <p className={styles.meta}>Text that holds JSON</p>}
            <Segmented<JsonView>
                value={view}
                options={detected ? DETECTED_VIEWS : JSON_VIEWS}
                label="JSON view"
                onChange={switchView}
            />
            {view === "tree" ? (
                problem ? (
                    <p className={styles.meta}>Fix the JSON to see it as a tree.</p>
                ) : (
                    <ul className={styles.tree} aria-label="JSON tree">
                        <JsonNode name={null} value={parsed} />
                    </ul>
                )
            ) : (
                <JsonCode
                    text={text}
                    baseline={baseline}
                    highlight={view !== "text" || !parseError}
                    label={view === "raw" ? "Raw JSON" : view === "text" ? "Text" : "JSON"}
                    invalid={touched && !!problem}
                    onChange={(t) => {
                        setText(t);
                        setTouched(true);
                    }}
                    onSave={save}
                />
            )}
            {changes.length > 0 && <ChangeList changes={changes} />}
            {empty ? (
                <p className={styles.null}>NULL</p>
            ) : view === "text" ? (
                <p className={styles.meta}>
                    {[...text].length.toLocaleString("en-US")} characters
                    {parseError ? " · not JSON, saved as text" : ""}
                </p>
            ) : problem ? (
                <p className={styles.invalid} role="alert">
                    <TriangleAlert size={12} /> Invalid JSON: {problem}
                </p>
            ) : (
                <p className={styles.valid}>
                    <Check size={12} /> Valid JSON
                </p>
            )}
            <Footer
                edit={edit}
                canSave={touched && !problem}
                onSave={save}
                extra={
                    <button
                        type="button"
                        className={controls.ghost}
                        disabled={!!problem || view === "tree"}
                        onClick={() => {
                            setText(JSON.stringify(parsed, null, 2));
                            setView("json");
                        }}
                    >
                        Format
                    </button>
                }
            />
        </>
    );
}

/** `undefined` when `text` is NULL or not JSON. */
function parseJson(text: string | null): unknown {
    if (text === null) return undefined;
    try {
        return JSON.parse(text);
    } catch {
        return undefined;
    }
}

const MAX_CHANGES = 6;

function shortJson(value: unknown): string {
    const text = JSON.stringify(value);
    return text.length > 40 ? `${text.slice(0, 39)}…` : text;
}

/** The values that differ from the value before any staged change: `seats null → 250`. */
function ChangeList({ changes }: { changes: JsonChange[] }) {
    const shown = changes.slice(0, MAX_CHANGES);
    return (
        <ul className={styles.changes} aria-label="Changed values">
            {shown.map((c) => (
                <li key={c.path}>
                    <span className={styles.changePath}>{c.path}</span>
                    {c.before !== undefined && <span className={styles.changeBefore}>{shortJson(c.before)}</span>}
                    {c.before !== undefined && c.after !== undefined && (
                        <span className={styles.changeArrow} aria-hidden>
                            <ArrowRight size={11} />
                        </span>
                    )}
                    {c.after !== undefined && (
                        <span className={styles.changeAfter} data-added={c.before === undefined || undefined}>
                            {shortJson(c.after)}
                        </span>
                    )}
                </li>
            ))}
            {changes.length > MAX_CHANGES && (
                <li className={styles.changePath}>and {changes.length - MAX_CHANGES} more</li>
            )}
        </ul>
    );
}

function JsonNode({ name, value }: { name: string | null; value: unknown }) {
    const label = name === null ? null : <span className={styles.treeKey}>{name}: </span>;
    if (value !== null && typeof value === "object") {
        const entries = Array.isArray(value)
            ? value.map((v, i) => [String(i), v] as const)
            : Object.entries(value as Record<string, unknown>);
        return (
            <li className={styles.treeItem}>
                {label}
                <span className={styles.meta}>
                    {Array.isArray(value) ? `[${entries.length}]` : `{${entries.length}}`}
                </span>
                <ul className={styles.treeGroup}>
                    {entries.map(([k, v]) => (
                        <JsonNode key={k} name={k} value={v} />
                    ))}
                </ul>
            </li>
        );
    }
    return (
        <li className={styles.treeItem}>
            {label}
            <span data-json={value === null ? "null" : typeof value}>{JSON.stringify(value)}</span>
        </li>
    );
}

function ArrayEditor({ edit, start, items }: { edit: InspectorEdit; start: string | null; items: PgArray }) {
    const [list, setList] = useState<(string | null)[]>(items as (string | null)[]);
    const [touched, setTouched] = useState(false);
    // biome-ignore lint/correctness/useExhaustiveDependencies: a new cell or staged value restarts the editor
    useEffect(() => {
        setList(items as (string | null)[]);
        setTouched(false);
    }, [start, edit.staged]);

    const update = (next: (string | null)[]) => {
        setList(next);
        setTouched(true);
    };
    const move = (i: number, by: number) => {
        const next = [...list];
        const [item] = next.splice(i, 1);
        next.splice(i + by, 0, item ?? null);
        update(next);
    };

    return (
        <>
            <StagedNote edit={edit} />
            {start === null && !touched && <p className={styles.null}>NULL</p>}
            <ol className={styles.arrayEdit} aria-label="Array items">
                {list.map((item, i) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: array elements are positional
                    <li key={i}>
                        <input
                            className={controls.input}
                            value={item ?? ""}
                            placeholder={item === null ? "NULL" : ""}
                            aria-label={`Item ${i + 1}`}
                            spellCheck={false}
                            onChange={(e) => update(list.map((v, j) => (j === i ? e.target.value : v)))}
                        />
                        <button
                            type="button"
                            className={controls.iconButton}
                            aria-label={`Set item ${i + 1} to NULL`}
                            title="Set to NULL"
                            onClick={() => update(list.map((v, j) => (j === i ? null : v)))}
                        >
                            ∅
                        </button>
                        <button
                            type="button"
                            className={controls.iconButton}
                            aria-label={`Move item ${i + 1} up`}
                            disabled={i === 0}
                            onClick={() => move(i, -1)}
                        >
                            <ArrowUp size={12} />
                        </button>
                        <button
                            type="button"
                            className={controls.iconButton}
                            aria-label={`Move item ${i + 1} down`}
                            disabled={i === list.length - 1}
                            onClick={() => move(i, 1)}
                        >
                            <ArrowDown size={12} />
                        </button>
                        <button
                            type="button"
                            className={controls.iconButton}
                            aria-label={`Remove item ${i + 1}`}
                            onClick={() => update(list.filter((_, j) => j !== i))}
                        >
                            <X size={12} />
                        </button>
                    </li>
                ))}
            </ol>
            <Footer
                edit={edit}
                canSave={touched}
                onSave={() => edit.stage({ kind: "text", text: serializePgArray(list) })}
                extra={
                    <button type="button" className={controls.ghost} onClick={() => update([...list, ""])}>
                        <Plus size={12} />
                        Add item
                    </button>
                }
            />
        </>
    );
}

function BinaryEditor({
    edit,
    value,
    onSaveToFile,
}: {
    edit: InspectorEdit;
    value: FullValue | null;
    onSaveToFile: (() => void) | null;
}) {
    const staged = edit.staged;
    return (
        <>
            <StagedNote edit={edit} />
            {staged?.kind === "file" ? (
                <p className={styles.meta}>
                    {staged.image ? `${staged.image.toUpperCase()} image` : "Binary"}, {formatBytes(staged.size)} — the
                    preview shows after commit.
                </p>
            ) : staged?.kind === "null" || (!staged && value?.null) ? (
                <p className={styles.null}>NULL</p>
            ) : (
                value &&
                !staged && (
                    <>
                        <p className={styles.meta}>Binary, {formatBytes(value.size ?? 0)}</p>
                        {value.image && <img className={styles.image} src={value.image} alt="Preview of the value" />}
                        {value.hex && <pre className={styles.hex}>{value.hex}</pre>}
                    </>
                )
            )}
            <div className={styles.footer}>
                <button type="button" className={controls.button} onClick={() => void edit.upload()}>
                    <Upload size={12} />
                    Upload from file
                </button>
                {onSaveToFile && !staged && value && !value.null && (
                    <button type="button" className={controls.ghost} onClick={onSaveToFile}>
                        <Download size={12} />
                        Download
                    </button>
                )}
                {edit.nullable && (
                    <button type="button" className={controls.ghost} onClick={() => edit.stage({ kind: "null" })}>
                        Set NULL
                    </button>
                )}
                <span className={styles.spacer} />
                <button type="button" className={controls.button} disabled={!staged} onClick={edit.revert}>
                    <RotateCcw size={12} />
                    Revert cell
                </button>
            </div>
        </>
    );
}

/** Asks where to save a value and saves it (the page value of a table tab). */
export async function saveValueToFile(name: string, save: (path: string) => Promise<unknown>) {
    const path = await chooseSaveFile({ title: `Save ${name}`, defaultPath: name });
    if (path) await save(path);
}
