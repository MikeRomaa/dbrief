import { Check, Copy, Download, PanelBottomOpen, TriangleAlert, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { DataGrid } from "@/components/grid/DataGrid";
import { MenuButton, type MenuEntry } from "@/components/ui/Menu";
import { useStore } from "@/hooks/useStore";
import { plural } from "@/lib/connections/connectionFormat";
import { type ColumnLayout, displayOrder, EMPTY_LAYOUT } from "@/lib/grid/columns";
import { inspectorTarget } from "@/lib/grid/inspector";
import { at, type Selection } from "@/lib/grid/selection";
import { backend } from "@/lib/ipc/backend";
import type { CopyFormat } from "@/lib/ipc/bindings";
import { type ExportFormat, type ResultActions, type ResultEntry, type ResultMap, toTsv } from "@/lib/scripts/results";
import { tooltip } from "@/lib/shell/tooltip";
import type { Store } from "@/lib/util/store";

import styles from "@/components/scripts/ResultBlock.module.css";
import controls from "@/components/ui/controls.module.css";

/**
 * A statement's result: a header with its row count and duration, then the rows, the error, or the
 * running timer. `maxRows` caps how many rows show before the grid scrolls (inline results).
 */
interface ResultBlockProps {
    store: Store<ResultMap>;
    id: string;
    actions: ResultActions;
    maxRows?: number;
    /** Fill the container (the bottom panel) instead of growing with the rows. */
    fill?: boolean;
}

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

export function ResultBlock({ store, id, actions, maxRows, fill }: ResultBlockProps) {
    const entry = useStore(store).get(id);
    if (!entry) return null;

    return (
        <section className={styles.block} data-fill={fill || undefined} aria-label={`Result ${entry.index}`}>
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
            <ResultGrid entry={entry} maxRows={maxRows} />
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

const NO_MATCHES: ReadonlySet<string> = new Set();
const NO_KEYS: ReadonlySet<string> = new Set();

/**
 * A result's rows in the data grid: column resize, reordering and hiding (kept while the result is
 * open), range copy and the inspector. Results are read-only and have no ORDER BY to rewrite.
 */
function ResultGrid({ entry, maxRows }: { entry: Extract<ResultEntry, { status: "done" }>; maxRows?: number }) {
    const columns = entry.columns ?? [];
    const { rows } = entry;
    const [layout, setLayout] = useState<ColumnLayout>(EMPTY_LAYOUT);
    const [selection, setSelection] = useState<Selection>(at(0, 0));
    const [focused, setFocused] = useState(false);
    const names = useMemo(() => columns.map((c) => c.name), [columns]);
    const visible = useMemo(() => displayOrder(names, layout), [names, layout]);

    // The inspector shows the active cell while the grid has focus.
    const column = visible[selection.focus.col];
    const values = rows[selection.focus.row];
    useEffect(() => {
        if (!focused || column === undefined || !values) return;
        inspectorTarget.set({
            sessionId: null,
            columns,
            cells: values,
            values,
            row: selection.focus.row,
            column,
            rowNumber: String(selection.focus.row + 1),
        });
    }, [focused, column, values, columns, selection.focus.row]);

    const copy = async (format: CopyFormat, picked: number[], cols: number[]) => {
        const pickedColumns = cols.map((c) => columns[c]).filter((c) => c !== undefined);
        const pickedRows = picked.map((r) => cols.map((c) => rows[r]?.[c] ?? null));
        const withHeaders = format === "tsv-with-headers";
        const text =
            format === "tsv" || withHeaders
                ? toTsv(pickedColumns, pickedRows)
                      .split("\n")
                      .slice(withHeaders ? 0 : 1)
                      .join("\n")
                : await backend.copyRows(pickedColumns, pickedRows, format, `"result_${entry.index}"`).catch(() => "");
        await navigator.clipboard.writeText(text).catch(() => {});
    };

    return (
        // biome-ignore lint/a11y/noStaticElementInteractions: tracks whether the grid inside has focus
        <div
            className={styles.gridHost}
            onFocus={() => setFocused(true)}
            onBlur={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocused(false);
            }}
        >
            <DataGrid
                id={`result-${entry.id}`}
                label={`Result ${entry.index}`}
                columns={columns}
                cells={rows}
                rowOffset={0}
                layout={layout}
                onLayoutChange={setLayout}
                order=""
                keyColumns={NO_KEYS}
                options={{ nullDisplay: "null", jsonTruncation: 100 }}
                selection={selection}
                onSelectionChange={setSelection}
                matches={NO_MATCHES}
                currentMatch={null}
                onCopy={(format, r, c) => void copy(format, r, c)}
                maxRows={maxRows}
            />
        </div>
    );
}
