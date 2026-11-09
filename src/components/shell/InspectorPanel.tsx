import { Check, Copy, Save } from "lucide-react";
import { useEffect, useState } from "react";

import { JsonCode } from "@/components/shell/JsonCode";
import { saveValueToFile, ValueEditor } from "@/components/shell/ValueEditor";
import { useStore } from "@/hooks/useStore";
import { cellText } from "@/lib/grid/cells";
import { looksLikeJson, validate } from "@/lib/grid/editors";
import { type InspectorEdit, inspectorTarget } from "@/lib/grid/inspector";
import { isArrayType, type PgArray, parsePgArray } from "@/lib/grid/pgArray";
import { backend, errorMessage, type Settings } from "@/lib/ipc/backend";
import type { FullValue } from "@/lib/ipc/bindings";
import { formatBytes } from "@/lib/util/numbers";

import styles from "@/components/shell/InspectorPanel.module.css";
import controls from "@/components/ui/controls.module.css";

type Tab = "cell" | "row";

/** A script result value as the inspector's full value. */
function memoryValue(text: string | null | undefined): FullValue {
    if (text == null) return { null: true, text: null, size: 0, hex: null, image: null };
    return { null: false, text, size: text.length, hex: null, image: null };
}

/**
 * The inspector's content for the active grid cell: its full value (text, pretty-printed JSON, an
 * array as a list, or a binary value's hex and image preview, with Save to file), or every column
 * of the row. When the cell can be edited, the Cell tab is its editor and the Row tab's fields edit
 * too; edits are staged in the table tab.
 */
export function InspectorPanel({ settings }: { settings: Settings | null }) {
    const target = useStore(inspectorTarget);
    const [tab, setTab] = useState<Tab>("cell");
    const [value, setValue] = useState<FullValue | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [copied, setCopied] = useState(false);

    const sessionId = target?.sessionId;
    const row = target?.row;
    const column = target?.column;
    const staged = target?.edit?.staged;
    // The value before any staged change; a staged copy of another row shows that row's value.
    const sourceRow = staged?.kind === "original" ? staged.row : row;
    // biome-ignore lint/correctness/useExhaustiveDependencies: a new page (new cells) means a new value at the same position
    useEffect(() => {
        setValue(null);
        setError(null);
        if (!target || column === undefined) return;
        if (!sessionId) {
            setValue(memoryValue(target.values?.[column]));
            return;
        }
        if (sourceRow === null || sourceRow === undefined) {
            setValue(memoryValue(null));
            return;
        }
        let cancelled = false;
        backend
            .pageValue(sessionId, sourceRow, column)
            .then((v) => !cancelled && setValue(v))
            .catch((e) => !cancelled && setError(errorMessage(e)));
        return () => {
            cancelled = true;
        };
    }, [sessionId, sourceRow, column, target?.values, row === null]);

    if (!target) {
        return <p className={styles.placeholder}>Select a cell in a table or result to see its full value.</p>;
    }

    const col = target.columns[target.column];
    const options = {
        nullDisplay: settings?.data_grid.null_display ?? "null",
        jsonTruncation: Number.MAX_SAFE_INTEGER,
    } as const;

    const saveToFile =
        target.sessionId && target.row !== null && !staged
            ? () =>
                  void saveValueToFile(col?.name ?? "value", (path) =>
                      backend.savePageValue(target.sessionId ?? "", target.row ?? 0, target.column, path),
                  ).catch((e) => setError(errorMessage(e)))
            : null;

    // What the cell holds now, staged changes included, for the read-only view.
    const shownValue: FullValue | null =
        staged?.kind === "text" ? memoryValue(staged.text) : staged?.kind === "null" ? memoryValue(null) : value;

    return (
        <div className={styles.inspector}>
            <div className={styles.tabs} role="tablist" aria-label="Inspector views">
                {(["cell", "row"] as const).map((t) => (
                    <button
                        key={t}
                        type="button"
                        role="tab"
                        aria-selected={tab === t}
                        tabIndex={tab === t ? 0 : -1}
                        className={styles.tab}
                        onClick={() => setTab(t)}
                        onKeyDown={(e) => {
                            if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
                                e.preventDefault();
                                setTab(t === "cell" ? "row" : "cell");
                            }
                        }}
                    >
                        {t === "cell" ? "Cell" : `Row ${target.rowNumber}`}
                    </button>
                ))}
            </div>

            {tab === "row" ? (
                <RowFields target={target} options={options} />
            ) : (
                <div className={styles.cell}>
                    <div className={styles.cellHeader}>
                        <span className={styles.name}>{col?.name}</span>
                        <span className={styles.type}>{col?.type_name.toLowerCase()}</span>
                        <span className={styles.spacer} />
                        {shownValue?.text != null && (
                            <button
                                type="button"
                                className={controls.iconButton}
                                aria-label="Copy value"
                                onClick={() => {
                                    void navigator.clipboard.writeText(shownValue.text ?? "").catch(() => {});
                                    setCopied(true);
                                    setTimeout(() => setCopied(false), 1500);
                                }}
                            >
                                {copied ? <Check size={13} /> : <Copy size={13} />}
                            </button>
                        )}
                        {saveToFile && value && !value.null && !target.edit && (
                            <button
                                type="button"
                                className={controls.iconButton}
                                aria-label="Save to file"
                                title="Save to file"
                                onClick={saveToFile}
                            >
                                <Save size={13} />
                            </button>
                        )}
                    </div>
                    <p className={styles.meta}>Row {target.rowNumber}</p>
                    {error && (
                        <p className={controls.error} role="alert">
                            {error}
                        </p>
                    )}
                    {target.edit
                        ? (value || target.row === null) && (
                              <ValueEditor edit={target.edit} value={value} onSaveToFile={saveToFile} />
                          )
                        : shownValue && <ValueView value={shownValue} typeName={col?.type_name ?? ""} />}
                </div>
            )}
        </div>
    );
}

/** The Row tab: every column of the row; short values of editable columns edit in place. */
function RowFields({
    target,
    options,
}: {
    target: NonNullable<ReturnType<typeof inspectorTarget.get>>;
    options: { nullDisplay: "null" | "symbol" | "blank"; jsonTruncation: number };
}) {
    return (
        <dl className={styles.rowList} aria-label={`Row ${target.rowNumber}`}>
            {target.columns.map((c, i) => {
                const cell = target.cells[i] ?? null;
                const shown = cellText(cell, c.type_name, { ...options, jsonTruncation: 200 });
                const edit = target.editFor?.(i) ?? null;
                const inline =
                    edit &&
                    !["binary", "array", "boolean"].includes(edit.kind) &&
                    (cell === null || (typeof cell === "string" && !/[\r\n]/.test(cell)));
                return (
                    // biome-ignore lint/suspicious/noArrayIndexKey: result columns can share a name
                    <div key={i} className={styles.rowItem}>
                        <dt>
                            {c.name} <span className={styles.type}>{c.type_name.toLowerCase()}</span>
                            {edit?.staged && <span className={styles.stagedMark}> · edited</span>}
                        </dt>
                        {inline && edit ? (
                            <RowField edit={edit} text={typeof cell === "string" ? cell : null} label={c.name} />
                        ) : (
                            <dd data-kind={shown.kind}>{shown.text || " "}</dd>
                        )}
                    </div>
                );
            })}
        </dl>
    );
}

function RowField({ edit, text, label }: { edit: InspectorEdit; text: string | null; label: string }) {
    const [draft, setDraft] = useState(text ?? "");
    const [problem, setProblem] = useState<string | null>(null);
    useEffect(() => {
        setDraft(text ?? "");
        setProblem(null);
    }, [text]);
    const save = () => {
        if (draft === (text ?? "")) return;
        const issue = validate(edit.kind, draft, edit.typeName, edit.engine);
        setProblem(issue);
        if (!issue) edit.stage({ kind: "text", text: draft });
    };
    return (
        <dd>
            <input
                className={`${controls.input} ${styles.rowInput}`}
                value={draft}
                placeholder={text === null ? (edit.defaultText ?? "NULL") : ""}
                aria-label={label}
                aria-invalid={!!problem || undefined}
                spellCheck={false}
                onChange={(e) => setDraft(e.target.value)}
                onBlur={save}
                onKeyDown={(e) => {
                    if (e.key === "Enter") save();
                    if (e.key === "Escape") setDraft(text ?? "");
                }}
            />
            {problem && (
                <span className={styles.invalid} role="alert">
                    {problem}
                </span>
            )}
        </dd>
    );
}

function ValueView({ value, typeName }: { value: FullValue; typeName: string }) {
    if (value.null) return <p className={styles.null}>NULL</p>;

    if (value.hex != null) {
        return (
            <>
                <p className={styles.meta}>Binary, {formatBytes(value.size ?? 0)}</p>
                {value.image && <img className={styles.image} src={value.image} alt="Preview of the value" />}
                <pre className={styles.hex}>{value.hex}</pre>
                {(value.size ?? 0) > 4096 && <p className={styles.meta}>Showing the first 4 kB.</p>}
            </>
        );
    }

    const text = value.text ?? "";
    if (/^jsonb?$/i.test(typeName) || looksLikeJson(text)) {
        let pretty = text;
        try {
            pretty = JSON.stringify(JSON.parse(text), null, 2);
        } catch {
            // Not valid JSON: show it as stored.
        }
        return <JsonCode text={pretty} baseline={null} label="JSON" />;
    }

    if (isArrayType(typeName)) {
        const items = parsePgArray(text);
        if (items) return <ArrayList items={items} />;
    }

    return (
        <>
            <pre className={styles.text}>{text}</pre>
            <p className={styles.meta}>{[...text].length.toLocaleString("en-US")} characters</p>
        </>
    );
}

function ArrayList({ items }: { items: PgArray }) {
    if (items.length === 0) return <p className={styles.meta}>Empty array</p>;
    return (
        <ol className={styles.array}>
            {items.map((item, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: array elements are positional
                <li key={i}>
                    {item === null ? (
                        <span className={styles.null}>NULL</span>
                    ) : Array.isArray(item) ? (
                        <ArrayList items={item} />
                    ) : (
                        item
                    )}
                </li>
            ))}
        </ol>
    );
}
