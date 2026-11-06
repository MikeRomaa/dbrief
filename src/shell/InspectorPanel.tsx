import { save as chooseSaveFile } from "@tauri-apps/plugin-dialog";
import { Check, Copy, Save } from "lucide-react";
import { useEffect, useState } from "react";

import { cellText } from "@/grid/cells";
import { inspectorTarget } from "@/grid/inspector";
import { isArrayType, type PgArray, parsePgArray } from "@/grid/pgArray";
import { backend, errorMessage, type Settings } from "@/lib/backend";
import type { FullValue } from "@/lib/bindings";
import { formatBytes } from "@/lib/numbers";
import { useStore } from "@/lib/store";

import styles from "@/shell/InspectorPanel.module.css";
import controls from "@/ui/controls.module.css";

type Tab = "cell" | "row";

/**
 * The inspector's content for the active grid cell: its full value (text, pretty-printed JSON, an
 * array as a list, or a binary value's hex and image preview, with Save to file), or every column
 * of the row. Editing arrives with grid editing.
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
    // biome-ignore lint/correctness/useExhaustiveDependencies: a new page (new cells) means a new value at the same position
    useEffect(() => {
        setValue(null);
        setError(null);
        if (sessionId === undefined || row === undefined || column === undefined) return;
        let cancelled = false;
        backend
            .pageValue(sessionId, row, column)
            .then((v) => !cancelled && setValue(v))
            .catch((e) => !cancelled && setError(errorMessage(e)));
        return () => {
            cancelled = true;
        };
    }, [sessionId, row, column, target?.cells]);

    if (!target) {
        return <p className={styles.placeholder}>Select a cell in a table to see its full value.</p>;
    }

    const col = target.columns[target.column];
    const options = {
        nullDisplay: settings?.data_grid.null_display ?? "null",
        jsonTruncation: Number.MAX_SAFE_INTEGER,
    } as const;

    const saveToFile = async () => {
        const path = await chooseSaveFile({ title: `Save ${col?.name ?? "value"}`, defaultPath: col?.name ?? "value" });
        if (!path) return;
        await backend
            .savePageValue(target.sessionId, target.row, target.column, path)
            .catch((e) => setError(errorMessage(e)));
    };

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
                <dl className={styles.rowList} aria-label={`Row ${target.rowNumber}`}>
                    {target.columns.map((c, i) => {
                        const shown = cellText(target.cells[i] ?? null, c.type_name, {
                            ...options,
                            jsonTruncation: 200,
                        });
                        return (
                            // biome-ignore lint/suspicious/noArrayIndexKey: result columns can share a name
                            <div key={i} className={styles.rowItem}>
                                <dt>
                                    {c.name} <span className={styles.type}>{c.type_name.toLowerCase()}</span>
                                </dt>
                                <dd data-kind={shown.kind}>{shown.text || " "}</dd>
                            </div>
                        );
                    })}
                </dl>
            ) : (
                <div className={styles.cell}>
                    <div className={styles.cellHeader}>
                        <span className={styles.name}>{col?.name}</span>
                        <span className={styles.type}>{col?.type_name.toLowerCase()}</span>
                        <span className={styles.spacer} />
                        {value?.text != null && (
                            <button
                                type="button"
                                className={controls.iconButton}
                                aria-label="Copy value"
                                onClick={() => {
                                    void navigator.clipboard.writeText(value.text ?? "").catch(() => {});
                                    setCopied(true);
                                    setTimeout(() => setCopied(false), 1500);
                                }}
                            >
                                {copied ? <Check size={13} /> : <Copy size={13} />}
                            </button>
                        )}
                        {value && !value.null && (
                            <button
                                type="button"
                                className={controls.iconButton}
                                aria-label="Save to file"
                                title="Save to file"
                                onClick={() => void saveToFile()}
                            >
                                <Save size={13} />
                            </button>
                        )}
                    </div>
                    {error && (
                        <p className={controls.error} role="alert">
                            {error}
                        </p>
                    )}
                    {value && <ValueView value={value} typeName={col?.type_name ?? ""} />}
                </div>
            )}
        </div>
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
    if (/^jsonb?$/i.test(typeName)) {
        let pretty = text;
        try {
            pretty = JSON.stringify(JSON.parse(text), null, 2);
        } catch {
            // Not valid JSON: show it as stored.
        }
        return <pre className={styles.text}>{pretty}</pre>;
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
