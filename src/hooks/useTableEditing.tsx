import { open as chooseFile } from "@tauri-apps/plugin-dialog";
import { useEffect, useMemo, useRef, useState } from "react";

import { CommitDialog } from "@/components/ui/CommitDialog";
import { Dialog } from "@/components/ui/Dialog";
import { plural } from "@/lib/connections/connectionFormat";
import type { CellDisplay, CellEdit, GridAction, GridEditing } from "@/lib/grid/editing";
import { booleanText, editorKind, hasTimeZone, isTrue, validate } from "@/lib/grid/editors";
import type { InspectorEdit } from "@/lib/grid/inspector";
import { at, rangeOf, type Selection, spans } from "@/lib/grid/selection";
import {
    addRow,
    cellValue,
    counts,
    deleteRows,
    EMPTY_HISTORY,
    hasFiles,
    indexOf,
    isEmpty,
    push,
    type RowRef,
    redo,
    revertCell,
    revertRow,
    rowAt,
    rowState,
    type StagedValue,
    type Staging,
    type StagingHistory,
    setCell,
    toChanges,
    undelete,
    undo,
} from "@/lib/grid/staging";
import { parseTsv, planPaste } from "@/lib/grid/tsv";
import { backend, EditFailureError, errorMessage } from "@/lib/ipc/backend";
import type {
    Cell,
    Connection,
    EditColumn_Serialize,
    EditInfo_Serialize,
    SessionInfo,
    TablePage,
    TransactionMode,
    TransactionStatement,
} from "@/lib/ipc/bindings";
import { log } from "@/lib/shell/log";
import { showPanel, stagedPanel } from "@/lib/shell/staged";
import type { TableRef } from "@/lib/tabs/tableTabs";

import controls from "@/components/ui/controls.module.css";

/**
 * Editing a table tab's data: the table's row identity and columns, the staged changes (with undo),
 * the tab's transaction mode and open transaction, applying or committing the changes, and the
 * actions the grid and inspector send. Staged changes belong to the loaded page, so anything that
 * reloads it goes through `guard`, which asks first.
 */
interface Params {
    table: TableRef;
    source: string;
    connection: Connection | undefined;
    active: boolean;
    session: SessionInfo | null;
    page: TablePage | null;
    offset: number;
    visible: number[];
    selection: Selection;
    setSelection: (selection: Selection) => void;
    /** Reloads the current page and count, without asking about staged changes. */
    reload: () => Promise<void>;
    setProblem: (problem: string | null) => void;
}

type Pending =
    | { kind: "confirm"; statements: TransactionStatement[]; staged: boolean }
    | { kind: "navigate"; proceed: () => void };

const oneLine = (sql: string) => sql.replace(/\s+/g, " ").trim();

/** What DEFAULT shows: the default expression, or "default" for identities and sequences. */
function defaultText(column: EditColumn_Serialize | undefined): string | null {
    const value = column?.default_value;
    if (!value) return null;
    if (value === "identity" || value.startsWith("nextval(")) return "default";
    return value.replace(/::[\w\s".[\]]+$/, "");
}

function stagedCell(value: StagedValue, page: TablePage | null, column: number): Cell | null {
    switch (value.kind) {
        case "null":
        case "default":
            return null;
        case "text":
            return value.text;
        case "original":
            return page?.page.cells[value.row]?.[column] ?? null;
        case "file":
            return { binary: value.size, image: value.image };
    }
}

export function useTableEditing({
    table,
    source,
    connection,
    active,
    session,
    page,
    offset,
    visible,
    selection,
    setSelection,
    reload,
    setProblem,
}: Params) {
    const [info, setInfo] = useState<EditInfo_Serialize | null>(null);
    const [history, setHistory] = useState<StagingHistory>(EMPTY_HISTORY);
    const [mode, setModeState] = useState<TransactionMode | null>(null);
    const [txOpen, setTxOpen] = useState(false);
    const [busy, setBusy] = useState(false);
    const [pending, setPending] = useState<Pending | null>(null);
    const [failedRow, setFailedRow] = useState<RowRef | null>(null);
    const staging = history.current;
    const engine = connection?.engine ?? "postgres";
    const effectiveMode: TransactionMode = mode ?? (connection?.manual_transactions ? "manual" : "auto");

    const columns = page?.page.columns ?? [];
    const pageRows = page?.page.cells.length ?? 0;
    const byName = useMemo(() => new Map((info?.columns ?? []).map((c) => [c.name, c])), [info]);
    const editable = !!info?.identity && !!page;
    const stagedCounts = counts(staging);

    /**
     * Loads the row identity and columns (before the first page, and on Reload). Returns the SQLite
     * rowid name the page query needs, if the table is edited through its rowid.
     */
    const loadInfo = async (): Promise<string | null> => {
        let next: EditInfo_Serialize;
        try {
            next = await backend.tableEditInfo(table.connectionId, {
                schema: table.schema,
                name: table.name,
                kind: table.kind,
                detail: null,
            });
        } catch (e) {
            next = { identity: null, read_only: `Read-only: ${errorMessage(e)}`, columns: [] };
        }
        setInfo(next);
        return next.identity?.kind === "rowid" ? next.identity.rowid : null;
    };

    // A new session starts in the tab's mode.
    const sessionId = session?.id ?? null;
    // biome-ignore lint/correctness/useExhaustiveDependencies: set once per session
    useEffect(() => {
        if (sessionId) void backend.setTransactionMode(sessionId, effectiveMode).catch(() => {});
        // Staged changes point at the page of the session that loaded it.
        else setHistory(EMPTY_HISTORY);
        setTxOpen(false);
    }, [sessionId]);

    const change = (next: Staging) => {
        setHistory((h) => push(h, next));
        setFailedRow(null);
    };

    const clearStaging = () => {
        setHistory(EMPTY_HISTORY);
        setFailedRow(null);
    };

    const discard = () => {
        if (session && hasFiles(staging)) void backend.discardUploads(session.id).catch(() => {});
        clearStaging();
    };

    const refAt = (row: number) => rowAt(staging, pageRows, row);
    const columnName = (column: number) => columns[column]?.name ?? "";

    const display = (row: number, column: number): CellDisplay | undefined => {
        const ref = refAt(row);
        if (!ref) return undefined;
        const name = columnName(column);
        const value = cellValue(staging, ref, name);
        if (!value) {
            if (ref.kind === "page") return undefined;
            const text = defaultText(byName.get(name));
            return text ? { kind: "default", text } : { kind: "value", cell: null };
        }
        if (value.kind === "default") return { kind: "default", text: defaultText(byName.get(name)) ?? "DEFAULT" };
        return { kind: "value", cell: stagedCell(value, page, column) };
    };

    /** The cell as it would be committed: staged, else the page value. */
    const currentCell = (row: number, column: number): Cell | null => {
        const shown = display(row, column);
        if (shown?.kind === "value") return shown.cell;
        if (shown?.kind === "default") return null;
        return page?.page.cells[row]?.[column] ?? null;
    };

    const writable = (row: number, column: number): EditColumn_Serialize | null => {
        if (!editable) return null;
        const ref = refAt(row);
        if (!ref || rowState(staging, ref) === "deleted") return null;
        const col = byName.get(columnName(column));
        return col?.writable ? col : null;
    };

    const kindOf = (col: EditColumn_Serialize) => editorKind(col.base_type, engine);

    const edit = (row: number, column: number): CellEdit => {
        const col = writable(row, column);
        if (!col) return null;
        const kind = kindOf(col);
        if (kind === "boolean") return { kind: "toggle" };
        if (kind === "array" || kind === "binary") return { kind: "inspector" };
        const cell = currentCell(row, column);
        let initial = typeof cell === "string" ? cell : "";
        let load: (() => Promise<string>) | undefined;
        if (cell !== null && typeof cell !== "string") {
            if (cell.cut === undefined) return { kind: "inspector" };
            // Text cut short in the cell: the editor fetches the whole value from the page first.
            const ref = refAt(row);
            const staged = ref ? cellValue(staging, ref, col.name) : undefined;
            const source = staged?.kind === "original" ? staged.row : row < pageRows ? row : null;
            if (!session || source === null) return { kind: "inspector" };
            const sessionId = session.id;
            initial = cell.cut;
            load = () => backend.pageValue(sessionId, source, column).then((v) => v.text ?? "");
        }
        // JSON in a text column edits inline as text; the inspector still offers the JSON editor.
        return {
            kind: "editor",
            spec: {
                kind,
                typeName: col.base_type,
                engine,
                nullable: col.nullable,
                timeZone: hasTimeZone(col.base_type),
                initial,
                load,
                label: `${col.name}, row ${rowLabelOf(row)}`,
            },
        };
    };

    const rowLabelOf = (row: number) => {
        const ref = refAt(row);
        if (ref?.kind === "insert") return `+${row - pageRows + 1}`;
        return String(offset + row + 1);
    };

    const isOriginal = (row: number, column: number, value: StagedValue) => {
        if (row >= pageRows) return false;
        const original = page?.page.cells[row]?.[column];
        if (value.kind === "null") return original === null;
        if (value.kind === "text") return typeof original === "string" && original === value.text;
        if (value.kind === "original") return value.row === row;
        return false;
    };

    const stageAt = (s: Staging, row: number, column: number, value: StagedValue): Staging => {
        const ref = rowAt(s, pageRows, row);
        if (!ref) return s;
        return setCell(s, ref, columnName(column), value, isOriginal(row, column, value));
    };

    /** Selected grid rows and result columns. */
    const selected = () => {
        const { rows, cols } = spans(rangeOf(selection));
        const total = pageRows + staging.inserts.length;
        return {
            rows: rows.filter((r) => r < total),
            columns: cols.map((d) => visible[d]).filter((c): c is number => c !== undefined),
        };
    };

    const announce = (message: string) => setProblem(message);

    const textValue = (col: EditColumn_Serialize, text: string | null): StagedValue | string => {
        if (text === null) return col.nullable ? { kind: "null" } : `${col.name} can't be NULL.`;
        const problem = validate(kindOf(col), text, col.base_type, engine);
        if (problem) return `${col.name}: ${problem}`;
        return { kind: "text", text };
    };

    const commitText = (row: number, column: number, text: string | null, all: boolean) => {
        const targets = all
            ? selected().rows.flatMap((r) => selected().columns.map((c) => [r, c] as const))
            : [[row, column] as const];
        let next = staging;
        let skipped = 0;
        for (const [r, c] of targets) {
            const col = writable(r, c);
            const value = col ? textValue(col, text) : null;
            if (!col || typeof value === "string" || !value) {
                skipped++;
                continue;
            }
            next = stageAt(next, r, c, value);
        }
        change(next);
        if (skipped && all) announce(`${plural(skipped, "cell")} couldn't take that value and kept theirs.`);
    };

    const toggle = (row: number, column: number) => {
        const col = writable(row, column);
        if (!col) return;
        const cell = currentCell(row, column);
        const current = typeof cell === "string" ? isTrue(cell) : null;
        const next: StagedValue =
            current === null
                ? { kind: "text", text: booleanText(true, engine) }
                : current
                  ? { kind: "text", text: booleanText(false, engine) }
                  : col.nullable
                    ? { kind: "null" }
                    : { kind: "text", text: booleanText(true, engine) };
        change(stageAt(staging, row, column, next));
    };

    const setSelected = (value: StagedValue, what: string) => {
        const { rows, columns: cols } = selected();
        let next = staging;
        let skipped = 0;
        let done = 0;
        for (const r of rows) {
            for (const c of cols) {
                const col = writable(r, c);
                if (!col || (value.kind === "null" && !col.nullable)) {
                    skipped++;
                    continue;
                }
                next = stageAt(next, r, c, value);
                done++;
            }
        }
        change(next);
        announce(
            skipped
                ? `${plural(done, "cell")} set to ${what}; ${plural(skipped, "cell")} can't be ${what} and kept theirs.`
                : `${plural(done, "cell")} set to ${what}.`,
        );
    };

    /** The value to copy from a cell to another row of the same column. */
    const copyOf = (row: number, column: number): StagedValue => {
        const ref = refAt(row);
        const staged = ref ? cellValue(staging, ref, columnName(column)) : undefined;
        if (staged) return staged;
        if (ref?.kind === "page") return { kind: "original", row };
        return { kind: "default" };
    };

    const fillDown = () => {
        const { rows, columns: cols } = selected();
        const [top, ...rest] = rows;
        if (top === undefined || rest.length === 0) return announce("Select cells below a value to fill down.");
        let next = staging;
        for (const c of cols) {
            const value = copyOf(top, c);
            for (const r of rest) if (writable(r, c)) next = stageAt(next, r, c, value);
        }
        change(next);
    };

    const addRows = (sources: number[]) => {
        let next = staging;
        let first: RowRef | null = null;
        for (const source of sources.length ? sources : [-1]) {
            const values = new Map<string, StagedValue>();
            if (source >= 0) {
                columns.forEach((c, i) => {
                    const col = byName.get(c.name);
                    // Keys with a default (identities, sequences) get a new one; a copy would clash.
                    const key =
                        info?.identity?.kind === "key" && info.identity.columns.includes(c.name) && col?.default_value;
                    if (col?.writable && !key) values.set(c.name, copyOf(source, i));
                });
            }
            const [added, ref] = addRow(next, values);
            next = added;
            first ??= ref;
        }
        change(next);
        if (first) {
            const index = indexOf(next, pageRows, first);
            const firstEditable = visible.findIndex((c) => byName.get(columns[c]?.name ?? "")?.writable);
            setSelection(at(index, Math.max(0, firstEditable)));
        }
    };

    const removeRows = () => {
        const refs = selected()
            .rows.map(refAt)
            .filter((r): r is RowRef => r !== null);
        change(deleteRows(staging, refs));
        announce(`${plural(refs.length, "row")} marked for deletion.`);
    };

    const revertSelection = () => {
        const { rows, columns: cols } = selected();
        let next = staging;
        for (const r of rows) {
            const ref = refAt(r);
            if (!ref) continue;
            if (ref.kind === "page" && next.deletes.has(ref.row)) {
                next = undelete(next, ref.row);
                continue;
            }
            if (cols.length === visible.length) {
                next = revertRow(next, ref);
                continue;
            }
            for (const c of cols) next = revertCell(next, ref, columnName(c));
        }
        change(next);
    };

    const paste = (text: string) => {
        const block = parseTsv(text);
        if (block.length === 0) return;
        const cells = planPaste(block, rangeOf(selection), visible.length);
        const total = pageRows + staging.inserts.length;
        const newRows = Math.max(0, ...cells.map((c) => c.row + 1 - total));

        // Values are checked first; one bad value stops the whole paste.
        let next = staging;
        for (let i = 0; i < newRows; i++) next = addRow(next)[0];
        let skipped = 0;
        for (const cell of cells) {
            const column = visible[cell.col];
            if (column === undefined) continue;
            const ref = rowAt(next, pageRows, cell.row);
            const col = byName.get(columnName(column));
            if (!ref || !col?.writable || rowState(next, ref) === "deleted") {
                skipped++;
                continue;
            }
            const problem = validate(kindOf(col), cell.text, col.base_type, engine);
            if (problem) {
                announce(`Nothing was pasted: row ${rowLabelOf(cell.row)}, ${col.name}: ${problem}`);
                return;
            }
            next = setCell(
                next,
                ref,
                col.name,
                { kind: "text", text: cell.text },
                isOriginal(cell.row, column, {
                    kind: "text",
                    text: cell.text,
                }),
            );
        }
        change(next);
        const parts = [`Pasted ${plural(cells.length - skipped, "cell")}`];
        if (newRows) parts.push(`added ${plural(newRows, "row")}`);
        if (skipped) parts.push(`skipped ${plural(skipped, "cell")} that can't be written`);
        announce(`${parts.join(", ")}.`);
    };

    const onAction = (action: GridAction) => {
        if (!editable) return;
        switch (action.kind) {
            case "commit":
                return commitText(action.row, action.column, action.text, action.all);
            case "toggle":
                return toggle(action.row, action.column);
            case "inspect":
                return showPanel("inspector");
            case "set-null":
                return setSelected({ kind: "null" }, "NULL");
            case "set-default":
                return setSelected({ kind: "default" }, "DEFAULT");
            case "fill-down":
                return fillDown();
            case "add-row":
                return addRows([]);
            case "duplicate-rows":
                return addRows(selected().rows);
            case "delete-rows":
                return removeRows();
            case "revert":
                return revertSelection();
            case "paste":
                return paste(action.text);
            case "undo":
                return setHistory(undo);
            case "redo":
                return setHistory(redo);
        }
    };

    const editing: GridEditing | undefined = editable
        ? {
              display,
              rowState: (row) => {
                  const ref = refAt(row);
                  return ref ? rowState(staging, ref) : null;
              },
              rowLabel: (row) => (row >= pageRows ? `+${row - pageRows + 1}` : null),
              edited: (row, column) => {
                  const ref = refAt(row);
                  return ref?.kind === "page" && !!cellValue(staging, ref, columnName(column));
              },
              edit,
              onAction,
          }
        : undefined;

    // Inserted rows follow the page rows; their cells come from `display`.
    const cells = useMemo(() => {
        const base = page?.page.cells ?? [];
        if (staging.inserts.length === 0) return base;
        return [...base, ...staging.inserts.map(() => columns.map(() => null))];
    }, [page, staging.inserts, columns]);

    const inspectorEdit = (row: number, column: number): InspectorEdit | null => {
        const col = writable(row, column);
        const ref = refAt(row);
        if (!col || !ref) return null;
        const name = col.name;
        return {
            kind: kindOf(col),
            typeName: col.base_type,
            engine,
            nullable: col.nullable,
            staged: cellValue(staging, ref, name),
            defaultText: ref.kind === "insert" ? defaultText(col) : null,
            stage: (value) => change(stageAt(staging, row, column, value)),
            revert: () => change(revertCell(staging, ref, name)),
            upload: async () => {
                if (!session) return;
                const path = await chooseFile({ title: `Upload into ${name}`, multiple: false, directory: false });
                if (typeof path !== "string") return;
                try {
                    const file = await backend.stageFile(session.id, path);
                    change(
                        stageAt(staging, row, column, {
                            kind: "file",
                            token: file.token,
                            size: file.size,
                            image: file.image ?? null,
                        }),
                    );
                } catch (e) {
                    setProblem(errorMessage(e));
                }
            },
        };
    };

    const logStatements = (statements: TransactionStatement[]) => {
        for (const s of statements) {
            log({
                kind: "statement",
                source: `${source} · grid`,
                text: oneLine(s.sql),
                detail: s.rows_affected == null ? undefined : `${plural(s.rows_affected, "row")} affected`,
            });
        }
    };

    const batch = () => {
        const identity = info?.identity;
        if (!identity) return null;
        const { changes, rows } = toChanges(staging);
        return {
            batch: { schema: table.schema, name: table.name, identity, columns: info.columns, changes },
            rows,
        };
    };

    /** Applies or commits the staged changes; `then` runs after they succeed. */
    const apply = async (then?: () => void) => {
        const built = batch();
        if (!session || !built || isEmpty(staging) || busy) return;
        const confirm = effectiveMode === "auto" && !!connection?.confirm_before_commit;
        setBusy(true);
        try {
            if (effectiveMode === "auto") log({ kind: "transaction", source, text: "BEGIN" });
            const outcome = await backend.applyChanges(session.id, built.batch, confirm);
            logStatements(outcome.statements);
            if (outcome.state === "awaiting-confirm") {
                setTxOpen(true);
                setPending({ kind: "confirm", statements: outcome.statements, staged: true });
                return;
            }
            if (outcome.state === "committed") log({ kind: "transaction", source, text: "COMMIT" });
            setTxOpen(outcome.in_transaction);
            clearStaging();
            setProblem(null);
            await reload();
            then?.();
        } catch (e) {
            if (e instanceof EditFailureError) {
                const ref = e.failure.change != null ? built.rows[e.failure.change] : undefined;
                const where = ref ? `Row ${rowLabelOf(indexOf(staging, pageRows, ref))}: ` : "";
                setProblem(`${where}${e.message}. Nothing was changed; the edits are still staged.`);
                log({
                    kind: "error",
                    source,
                    text: `${e.message}${e.failure.sql ? ` — ${oneLine(e.failure.sql)}` : ""}`,
                });
                if (effectiveMode === "auto") log({ kind: "transaction", source, text: "ROLLBACK" });
                if (ref) {
                    setFailedRow(ref);
                    const index = indexOf(staging, pageRows, ref);
                    if (index >= 0) setSelection(at(index, selection.focus.col));
                }
                if (e.failure.error.kind === "transaction-lost") {
                    setTxOpen(false);
                    await backend.acknowledgeLostTransaction(session.id).catch(() => {});
                }
            } else {
                setProblem(errorMessage(e));
            }
        } finally {
            setBusy(false);
        }
    };

    const commitTx = async (confirmed = false) => {
        if (!session || !txOpen) return;
        if (connection?.confirm_before_commit && !confirmed) {
            const state = await backend.transactionState(session.id).catch(() => null);
            setPending({ kind: "confirm", statements: state?.statements ?? [], staged: false });
            return;
        }
        try {
            await backend.commit(session.id);
            log({ kind: "transaction", source, text: "COMMIT" });
            setTxOpen(false);
            await reload();
        } catch (e) {
            log({ kind: "error", source, text: `COMMIT failed: ${errorMessage(e)}` });
            setProblem(errorMessage(e));
            setTxOpen(false);
        }
    };

    const rollbackTx = async () => {
        if (!session || !txOpen) return;
        try {
            await backend.rollback(session.id);
            log({ kind: "transaction", source, text: "ROLLBACK" });
        } catch (e) {
            setProblem(errorMessage(e));
        }
        setTxOpen(false);
        await reload();
    };

    const changeMode = async (next: TransactionMode) => {
        if (txOpen) return;
        setModeState(next);
        if (session) await backend.setTransactionMode(session.id, next).catch((e) => setProblem(errorMessage(e)));
    };

    /** ⌘S: applies staged changes when there are any, else commits the open transaction. */
    const save = () => {
        if (!isEmpty(staging)) void apply();
        else if (txOpen) void commitTx();
    };

    /** Runs `proceed` now, or after asking when staged changes would be lost. */
    const guard = (proceed: () => void) => {
        if (isEmpty(staging)) proceed();
        else setPending({ kind: "navigate", proceed });
    };

    const previewKey = useRef(0);
    // biome-ignore lint/correctness/useExhaustiveDependencies: refreshed when the staging changes
    useEffect(() => {
        if (!active) return;
        if (isEmpty(staging) || !session) {
            stagedPanel.set(null);
            return;
        }
        const built = batch();
        if (!built) return;
        const kinds = built.batch.changes.map((c) => c.kind);
        const rowLabels = built.rows.map((ref) => rowLabelOf(indexOf(staging, pageRows, ref)));
        const entries = kinds.map((kind, change) => ({ change, kind, row: rowLabels[change] ?? "", sql: null }));
        const revert = (index: number) => {
            const ref = built.rows[index];
            if (ref) change(revertRow(staging, ref));
        };
        stagedPanel.set({ source, counts: stagedCounts, entries, error: null, revert });

        const key = ++previewKey.current;
        const timer = setTimeout(() => {
            backend
                .previewChanges(session.id, built.batch)
                .then((statements) => {
                    if (key !== previewKey.current) return;
                    const sql = new Map(statements.map((s) => [s.change, s.sql]));
                    stagedPanel.set({
                        source,
                        counts: stagedCounts,
                        entries: entries.map((e) => ({ ...e, sql: sql.get(e.change) ?? null })),
                        error: null,
                        revert,
                    });
                })
                .catch((e) => {
                    if (key === previewKey.current) {
                        stagedPanel.set({ source, counts: stagedCounts, entries, error: errorMessage(e), revert });
                    }
                });
        }, 150);
        return () => clearTimeout(timer);
    }, [staging, active, session, page]);
    useEffect(() => () => stagedPanel.set(null), []);

    const dialogs = (
        <>
            {pending?.kind === "confirm" && (
                <CommitDialog
                    statements={pending.statements}
                    onCancel={() => {
                        // The transaction stays open; Commit and Roll back in the toolbar end it.
                        setPending(null);
                    }}
                    onRollback={() => {
                        setPending(null);
                        void rollbackTx();
                    }}
                    onCommit={() => {
                        const staged = pending.staged;
                        setPending(null);
                        void (async () => {
                            if (staged) {
                                clearStaging();
                                if (session) void backend.discardUploads(session.id).catch(() => {});
                            }
                            await commitTx(true);
                        })();
                    }}
                />
            )}
            {pending?.kind === "navigate" && (
                <Dialog
                    title="Staged changes"
                    onClose={() => setPending(null)}
                    footer={
                        <>
                            <button type="button" className={controls.button} onClick={() => setPending(null)}>
                                Cancel
                            </button>
                            <button
                                type="button"
                                className={controls.button}
                                onClick={() => {
                                    const { proceed } = pending;
                                    setPending(null);
                                    discard();
                                    proceed();
                                }}
                            >
                                Discard
                            </button>
                            <button
                                type="button"
                                className={controls.primary}
                                onClick={() => {
                                    const { proceed } = pending;
                                    setPending(null);
                                    void apply(proceed);
                                }}
                            >
                                {effectiveMode === "manual" ? "Apply" : "Commit"}
                            </button>
                        </>
                    }
                >
                    <p>
                        {plural(stagedCounts.total, "staged change")} belong to the rows loaded now. Apply them first,
                        or discard them?
                    </p>
                </Dialog>
            )}
        </>
    );

    return {
        info,
        loadInfo,
        editable,
        editing,
        cells,
        failedRow,
        staging,
        counts: stagedCounts,
        mode: effectiveMode,
        changeMode,
        txOpen,
        busy,
        apply,
        save,
        commitTx,
        rollbackTx,
        discard,
        guard,
        dialogs,
        inspectorEdit,
        rowLabelOf,
        refAt,
        canUndo: history.past.length > 0,
        undo: () => setHistory(undo),
    };
}
