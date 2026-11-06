import { Check, Copy, Download, PanelBottomOpen, TriangleAlert, X } from "lucide-react";
import { useEffect, useState } from "react";

import { plural } from "@/lib/connectionFormat";
import { type Store, useStore } from "@/lib/store";
import {
    type ExportFormat,
    isNumeric,
    type ResultActions,
    type ResultEntry,
    type ResultMap,
    toTsv,
} from "@/scripts/results";
import { tooltip } from "@/shell/TooltipLayer";
import { MenuButton, type MenuEntry } from "@/ui/Menu";

import styles from "@/scripts/ResultBlock.module.css";
import controls from "@/ui/controls.module.css";

/**
 * A statement's result: a header with its row count and duration, then the rows, the error, or the
 * running timer. `maxRows` caps how many rows show before the grid scrolls (inline results).
 */
interface ResultBlockProps {
    store: Store<ResultMap>;
    id: string;
    actions: ResultActions;
    maxRows?: number;
}

const ROW_HEIGHT = 24;

function formatDuration(ms: number | null): string {
    if (ms === null) return "";
    return ms < 1000 ? `${Math.max(1, Math.round(ms))} ms` : `${(ms / 1000).toFixed(2)} s`;
}

function Elapsed({ started }: { started: number }) {
    const [now, setNow] = useState(Date.now());
    useEffect(() => {
        const timer = setInterval(() => setNow(Date.now()), 100);
        return () => clearInterval(timer);
    }, []);

    const ms = now - started;
    const minutes = Math.floor(ms / 60_000);
    const seconds = ((ms % 60_000) / 1000).toFixed(1).padStart(4, "0");
    return (
        <span className={styles.mono}>
            {String(minutes).padStart(2, "0")}:{seconds}
        </span>
    );
}

export function ResultBlock({ store, id, actions, maxRows }: ResultBlockProps) {
    const entry = useStore(store).get(id);
    if (!entry) return null;

    return (
        <section className={styles.block} aria-label={`Result ${entry.index}`}>
            {entry.status === "running" ? (
                <div className={styles.header}>
                    <span className={styles.running}>Running</span>
                    <Elapsed started={entry.started} />
                    <span className={styles.spacer} />
                    <button type="button" className={controls.button} onClick={actions.cancel}>
                        <X size={12} />
                        Cancel
                    </button>
                </div>
            ) : entry.status === "failed" ? (
                <ErrorView entry={entry} onClose={() => actions.close(id)} />
            ) : (
                <DoneView entry={entry} actions={actions} maxRows={maxRows} />
            )}
        </section>
    );
}

function ErrorView({ entry, onClose }: { entry: Extract<ResultEntry, { status: "failed" }>; onClose: () => void }) {
    const { error } = entry;
    const code = error.kind === "query" ? error.error.code : null;
    const message = error.kind === "query" ? error.error.message : error.message;
    const detail = error.kind === "query" ? error.error.detail : null;
    const hint = error.kind === "query" ? error.error.hint : null;

    return (
        <div className={styles.error} role="alert">
            <TriangleAlert size={13} className={styles.errorIcon} />
            <div className={styles.errorText}>
                <div>
                    {code && <span className={styles.errorCode}>ERROR {code}</span>}
                    {message}
                </div>
                {detail && <div className={styles.errorMore}>{detail}</div>}
                {hint && <div className={styles.errorMore}>Hint: {hint}</div>}
                {error.kind === "blocked" && (
                    <div className={styles.errorMore}>Run it on a connection with a higher access level.</div>
                )}
            </div>
            <button type="button" className={controls.iconButton} aria-label="Close result" onClick={onClose}>
                <X size={12} />
            </button>
        </div>
    );
}

function DoneView({
    entry,
    actions,
    maxRows,
}: {
    entry: Extract<ResultEntry, { status: "done" }>;
    actions: ResultActions;
    maxRows?: number;
}) {
    const [copied, setCopied] = useState(false);
    const { columns, rows, more, output } = entry;

    if (!columns) {
        return (
            <div className={styles.header}>
                <Check size={13} className={styles.ok} />
                <span>{entry.rowsAffected === null ? "Done" : `${plural(entry.rowsAffected, "row")} affected`}</span>
                <span className={styles.meta}>{formatDuration(output.duration_ms)}</span>
                <span className={styles.spacer} />
                <button
                    type="button"
                    className={controls.iconButton}
                    aria-label="Close result"
                    onClick={() => actions.close(entry.id)}
                >
                    <X size={12} />
                </button>
            </div>
        );
    }

    const copy = async () => {
        await navigator.clipboard.writeText(toTsv(columns, rows)).catch(() => {});
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
    };

    const exportMenu: MenuEntry[] = (["csv", "json", "sql"] as ExportFormat[]).map((format) => ({
        label: { csv: "CSV", json: "JSON", sql: "SQL INSERT statements" }[format],
        onSelect: () => actions.exportResult(entry.id, format),
    }));

    const count = more ? `${rows.length}+ rows` : plural(rows.length, "row");

    return (
        <>
            <div className={styles.header}>
                <span className={styles.title}>Result {entry.index}</span>
                <span className={styles.meta}>
                    {count}, {formatDuration(output.duration_ms)}
                </span>
                <span className={styles.spacer} />
                <button
                    type="button"
                    className={controls.iconButton}
                    aria-label="Copy rows as TSV"
                    onClick={() => void copy()}
                    {...tooltip(copied ? "Copied" : "Copy rows (TSV)")}
                >
                    {copied ? <Check size={13} /> : <Copy size={13} />}
                </button>
                <MenuButton
                    label="Export"
                    entries={exportMenu}
                    align="end"
                    className={controls.iconButton}
                    attrs={tooltip("Export")}
                >
                    <Download size={13} />
                </MenuButton>
                {actions.popOut && (
                    <button
                        type="button"
                        className={controls.iconButton}
                        aria-label="Show in the bottom panel"
                        onClick={() => actions.popOut?.(entry.id)}
                        {...tooltip("Show in the bottom panel")}
                    >
                        <PanelBottomOpen size={13} />
                    </button>
                )}
                <button
                    type="button"
                    className={controls.iconButton}
                    aria-label="Close result"
                    onClick={() => actions.close(entry.id)}
                >
                    <X size={12} />
                </button>
            </div>
            <div className={styles.grid} style={maxRows ? { maxHeight: (maxRows + 1) * ROW_HEIGHT + 2 } : undefined}>
                <table>
                    <thead>
                        <tr>
                            {columns.map((c, i) => (
                                // biome-ignore lint/suspicious/noArrayIndexKey: columns can share a name
                                <th key={i} title={c.type_name} data-numeric={isNumeric(c.type_name) || undefined}>
                                    {c.name}
                                </th>
                            ))}
                        </tr>
                    </thead>
                    <tbody>
                        {rows.map((row, r) => (
                            // biome-ignore lint/suspicious/noArrayIndexKey: rows have no identity of their own
                            <tr key={r}>
                                {row.map((cell, c) => (
                                    <td
                                        // biome-ignore lint/suspicious/noArrayIndexKey: cells have no identity of their own
                                        key={c}
                                        data-null={cell === null || undefined}
                                        data-numeric={isNumeric(columns[c]?.type_name ?? "") || undefined}
                                        title={cell ?? "NULL"}
                                    >
                                        {cell ?? "NULL"}
                                    </td>
                                ))}
                            </tr>
                        ))}
                    </tbody>
                </table>
                {rows.length === 0 && <p className={styles.noRows}>No rows</p>}
            </div>
            {more && (
                <div className={styles.footer}>
                    <button
                        type="button"
                        className={controls.ghost}
                        disabled={entry.loadingMore}
                        onClick={() => actions.loadMore(entry.id)}
                    >
                        {entry.loadingMore ? "Loading…" : "Load more"}
                    </button>
                </div>
            )}
        </>
    );
}
