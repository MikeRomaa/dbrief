import { ChevronDown, ChevronRight, Ellipsis, Folder, FolderOpen, GripVertical, Pin } from "lucide-react";
import { type KeyboardEvent, type PointerEvent, useEffect, useRef, useState } from "react";

import { ACCESS_LABELS, colorTagVar, engineLabel, locationLabel, relativeTime } from "@/lib/connectionFormat";
import {
    type ConnectionTree,
    dropMove,
    dropPosition,
    type ItemRef,
    type Move,
    type Row,
    refOf,
    siblingMove,
    type TreeIndex,
} from "@/lib/connectionTree";
import { tooltip } from "@/shell/TooltipLayer";
import { EngineIcon } from "@/ui/EngineIcon";
import { MenuButton, type MenuEntry } from "@/ui/Menu";

import styles from "@/connections/ConnectionsView.module.css";
import controls from "@/ui/controls.module.css";

interface ConnectionTableProps {
    tree: ConnectionTree;
    index: TreeIndex;
    rows: Row[];
    selected: ItemRef | null;
    connected: ReadonlySet<string>;
    home: string | null;
    canReorder: boolean;
    onSelect: (item: ItemRef) => void;
    onToggle: (folderId: string, expanded: boolean) => void;
    onActivate: (row: Row) => void;
    onMove: (move: Move) => void;
    onPin: (connectionId: string, pinned: boolean) => void;
    onRemove: (item: ItemRef) => void;
    onRename: (folderId: string) => void;
    rowMenu: (row: Row) => MenuEntry[];
}

/** Pixels the pointer must travel before a press becomes a drag. */
const DRAG_THRESHOLD = 4;
/** Indent per tree level, in px. */
const INDENT = 20;
/** Distance from the top or bottom of the scroll area where dragging scrolls it. */
const SCROLL_EDGE = 28;

interface PendingDrag {
    row: Row;
    pointerId: number;
    startX: number;
    startY: number;
    active: boolean;
}

/** A drag in progress. `line` is the insertion line relative to the table; `null` when dropping into a folder. */
interface DragView {
    row: Row;
    x: number;
    y: number;
    move: Move | null;
    line: { top: number; left: number } | null;
    intoId: string | null;
}

const rowName = (row: Row) => (row.kind === "folder" ? row.folder.name : row.connection.name);

/**
 * The "All connections" tree table (WAI-ARIA treegrid). Rows take focus; arrows move, Enter
 * connects or opens, Alt+Up/Down reorders, Shift+F10 opens the row menu. Rows also drag with the
 * pointer: pointer events rather than HTML drag and drop, which Tauri's file-drop handling disables
 * on Windows.
 */
export function ConnectionTable(props: ConnectionTableProps) {
    const { rows, index, selected, canReorder } = props;
    const wrapperRef = useRef<HTMLDivElement>(null);
    const pendingRef = useRef<PendingDrag | null>(null);
    const suppressClick = useRef(false);
    const [drag, setDrag] = useState<DragView | null>(null);
    const [announcement, setAnnouncement] = useState("");

    const selectedIndex = rows.findIndex((r) => r.id === selected?.id);
    const focusIndex = Math.max(selectedIndex, 0);

    const rowElement = (i: number) => wrapperRef.current?.querySelector<HTMLElement>(`[data-row-index="${i}"]`);

    const focusRow = (i: number) => {
        const row = rows[i];
        if (!row) return;

        props.onSelect(refOf(row));
        rowElement(i)?.focus();
    };

    // Keep focus on the selected row when the rows change under it (e.g. after a move).
    useEffect(() => {
        if (selectedIndex < 0 || !wrapperRef.current?.contains(document.activeElement)) return;

        wrapperRef.current.querySelector<HTMLElement>(`[data-row-index="${selectedIndex}"]`)?.focus();
    }, [selectedIndex]);

    const dragging = drag !== null;
    useEffect(() => {
        if (!dragging) return;

        const cancel = (e: globalThis.KeyboardEvent) => {
            if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                pendingRef.current = null;
                setDrag(null);
            }
        };
        window.addEventListener("keydown", cancel, true);
        return () => window.removeEventListener("keydown", cancel, true);
    }, [dragging]);

    const openRowMenu = (at: number) => {
        rowElement(at)?.querySelector<HTMLButtonElement>("[data-row-menu]")?.click();
    };

    const onRowKeyDown = (at: number, e: KeyboardEvent<HTMLTableRowElement>) => {
        const row = rows[at];
        // Keys typed in the row's own buttons and menus are theirs.
        if (!row || e.target !== e.currentTarget) return;

        const handled = () => {
            e.preventDefault();
            e.stopPropagation();
        };

        if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
            handled();
            if (!canReorder) {
                setAnnouncement("Reordering works in manual order without a filter.");
                return;
            }

            const move = siblingMove(props.tree, index, refOf(row), e.key === "ArrowUp" ? -1 : 1);
            if (move) {
                props.onMove(move);
                setAnnouncement(`${rowName(row)}: ${move.label}`);
            }
            return;
        }

        switch (e.key) {
            case "ArrowDown":
                handled();
                focusRow(Math.min(at + 1, rows.length - 1));
                break;
            case "ArrowUp":
                handled();
                focusRow(Math.max(at - 1, 0));
                break;
            case "Home":
                handled();
                focusRow(0);
                break;
            case "End":
                handled();
                focusRow(rows.length - 1);
                break;
            case "ArrowRight":
                handled();
                if (row.kind === "folder" && !row.expanded) {
                    props.onToggle(row.id, true);
                } else if (row.kind === "folder" && rows[at + 1]?.parentId === row.id) {
                    focusRow(at + 1);
                }
                break;
            case "ArrowLeft":
                handled();
                if (row.kind === "folder" && row.expanded) {
                    props.onToggle(row.id, false);
                } else if (row.parentId) {
                    focusRow(rows.findIndex((r) => r.id === row.parentId));
                }
                break;
            case "Enter":
                handled();
                props.onActivate(row);
                break;
            case "Delete":
            case "Backspace":
                handled();
                props.onRemove(refOf(row));
                break;
            case "F2":
                if (row.kind === "folder") {
                    handled();
                    props.onRename(row.id);
                }
                break;
            case "ContextMenu":
                handled();
                openRowMenu(at);
                break;
            case "F10":
                if (e.shiftKey) {
                    handled();
                    openRowMenu(at);
                }
                break;
        }
    };

    const onPointerDown = (row: Row, e: PointerEvent<HTMLTableRowElement>) => {
        if (e.button !== 0 || !canReorder || (e.target as HTMLElement).closest("button")) return;

        pendingRef.current = { row, pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, active: false };
    };

    const onPointerMove = (e: PointerEvent<HTMLTableRowElement>) => {
        const pending = pendingRef.current;
        const wrapper = wrapperRef.current;
        if (!pending || !wrapper || e.pointerId !== pending.pointerId) return;

        if (!pending.active) {
            if (Math.hypot(e.clientX - pending.startX, e.clientY - pending.startY) < DRAG_THRESHOLD) return;

            pending.active = true;
            e.currentTarget.setPointerCapture(e.pointerId);
        }

        const scroller = wrapper.closest<HTMLElement>("[data-scroll]");
        if (scroller) {
            const area = scroller.getBoundingClientRect();
            if (e.clientY < area.top + SCROLL_EDGE) scroller.scrollTop -= 8;
            if (e.clientY > area.bottom - SCROLL_EDGE) scroller.scrollTop += 8;
        }

        let view: DragView = { row: pending.row, x: e.clientX, y: e.clientY, move: null, line: null, intoId: null };
        const hit = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>("[data-row-index]");
        const at = hit && wrapper.contains(hit) ? Number(hit.dataset.rowIndex) : -1;
        const target = rows[at];

        if (hit && target) {
            const rect = hit.getBoundingClientRect();
            const position = dropPosition(target, e.clientY - rect.top, rect.height);
            const move = dropMove(rows, index, refOf(pending.row), at, position);

            if (move) {
                const top = (position === "before" ? rect.top : rect.bottom) - wrapper.getBoundingClientRect().top;
                const depth = move.parentId === target.id ? target.depth + 1 : target.depth;
                view = {
                    ...view,
                    move,
                    line: position === "inside" ? null : { top, left: 28 + depth * INDENT },
                    intoId: position === "inside" ? target.id : null,
                };
            }
        }

        setDrag(view);
    };

    const onPointerUp = (e: PointerEvent<HTMLTableRowElement>) => {
        const pending = pendingRef.current;
        pendingRef.current = null;
        if (!pending?.active || e.pointerId !== pending.pointerId) return;

        suppressClick.current = true;
        const move = drag?.move;
        setDrag(null);

        if (move) {
            props.onMove(move);
            setAnnouncement(`${rowName(pending.row)}: ${move.label}`);
        }
    };

    return (
        <div ref={wrapperRef} className={styles.table}>
            <table
                // biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: a <table> is the WAI-ARIA APG's own treegrid example
                role="treegrid"
                aria-label="All connections"
                aria-describedby="connections-help"
                className={styles.grid}
            >
                <colgroup>
                    <col className={styles.colGrip} />
                    <col />
                    <col className={styles.colEngine} />
                    <col className={styles.colHost} />
                    <col className={styles.colAccess} />
                    <col className={styles.colUsed} />
                    <col className={styles.colActions} />
                </colgroup>
                <thead>
                    <tr>
                        <th scope="col">
                            <span className="visually-hidden">Drag handle</span>
                        </th>
                        <th scope="col">Name</th>
                        <th scope="col">Engine</th>
                        <th scope="col">Host</th>
                        <th scope="col">Access</th>
                        <th scope="col">Last used</th>
                        <th scope="col">
                            <span className="visually-hidden">Actions</span>
                        </th>
                    </tr>
                </thead>
                <tbody>
                    {rows.map((row, i) => (
                        <TableRow
                            key={row.id}
                            row={row}
                            rowIndex={i}
                            focusable={i === focusIndex}
                            props={props}
                            dragged={drag?.row.id === row.id}
                            dropInto={drag?.intoId === row.id}
                            onKeyDown={(e) => onRowKeyDown(i, e)}
                            onPointerDown={(e) => onPointerDown(row, e)}
                            onPointerMove={onPointerMove}
                            onPointerUp={onPointerUp}
                            onClick={() => {
                                if (suppressClick.current) {
                                    suppressClick.current = false;
                                    return;
                                }
                                props.onSelect(refOf(row));
                            }}
                        />
                    ))}
                </tbody>
            </table>
            {drag?.line && <div className={styles.dropLine} style={drag.line} aria-hidden="true" />}
            {drag && <DragLabel drag={drag} />}
            <p id="connections-help" className="visually-hidden">
                Arrow keys move between rows. Enter connects, or opens a folder. Alt with Up or Down arrow reorders.
                Shift F10 opens the row's actions.
            </p>
            <div className="visually-hidden" role="status">
                {announcement}
            </div>
        </div>
    );
}

interface TableRowProps {
    row: Row;
    rowIndex: number;
    focusable: boolean;
    props: ConnectionTableProps;
    dragged: boolean;
    dropInto: boolean;
    onKeyDown: (e: KeyboardEvent<HTMLTableRowElement>) => void;
    onPointerDown: (e: PointerEvent<HTMLTableRowElement>) => void;
    onPointerMove: (e: PointerEvent<HTMLTableRowElement>) => void;
    onPointerUp: (e: PointerEvent<HTMLTableRowElement>) => void;
    onClick: () => void;
}

function TableRow({
    row,
    rowIndex,
    focusable,
    props,
    dragged,
    dropInto,
    onKeyDown,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onClick,
}: TableRowProps) {
    const selected = props.selected?.id === row.id;
    const indent = 4 + row.depth * INDENT;
    const name = rowName(row);

    return (
        <tr
            className={styles.row}
            data-row-index={rowIndex}
            data-selected={selected || undefined}
            data-dragged={dragged || undefined}
            data-drop-into={dropInto || undefined}
            aria-level={row.depth + 1}
            aria-selected={selected}
            aria-expanded={row.kind === "folder" ? row.expanded : undefined}
            tabIndex={focusable ? 0 : -1}
            onKeyDown={onKeyDown}
            onClick={onClick}
            onDoubleClick={() => props.onActivate(row)}
            onContextMenu={(e) => {
                e.preventDefault();
                props.onSelect(refOf(row));
                e.currentTarget.querySelector<HTMLButtonElement>("[data-row-menu]")?.click();
            }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
        >
            <td className={styles.grip}>{props.canReorder && <GripVertical size={13} />}</td>
            {row.kind === "folder" ? (
                <>
                    <td>
                        <span className={styles.nameCell} style={{ paddingLeft: indent }}>
                            <button
                                type="button"
                                tabIndex={-1}
                                className={styles.chevron}
                                aria-label={row.expanded ? `Collapse ${name}` : `Expand ${name}`}
                                onClick={(e) => {
                                    e.stopPropagation();
                                    props.onToggle(row.id, !row.expanded);
                                }}
                            >
                                {row.expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                            </button>
                            <span className={styles.muted}>
                                {row.expanded ? <FolderOpen size={14} /> : <Folder size={14} />}
                            </span>
                            <span className={styles.folderName} data-top={row.depth === 0 || undefined}>
                                {name}
                            </span>
                            <span className={controls.count}>{row.folder.connection_count}</span>
                        </span>
                    </td>
                    <td />
                    <td />
                    <td />
                    <td />
                </>
            ) : (
                <ConnectionCells row={row} indent={indent} props={props} />
            )}
            <td>
                <span className={styles.actions}>
                    {row.kind === "connection" && (
                        <button
                            type="button"
                            tabIndex={-1}
                            className={controls.iconButton}
                            data-pinned={row.connection.pinned || undefined}
                            aria-label={row.connection.pinned ? `Unpin ${name}` : `Pin ${name}`}
                            aria-pressed={row.connection.pinned}
                            onClick={(e) => {
                                e.stopPropagation();
                                props.onPin(row.id, !row.connection.pinned);
                            }}
                            {...tooltip(row.connection.pinned ? "Unpin" : "Pin")}
                        >
                            <Pin size={13} />
                        </button>
                    )}
                    <MenuButton
                        label={`Actions for ${name}`}
                        entries={props.rowMenu(row)}
                        align="end"
                        className={controls.iconButton}
                        attrs={{ "data-row-menu": "" }}
                        tabIndex={-1}
                    >
                        <Ellipsis size={14} />
                    </MenuButton>
                </span>
            </td>
        </tr>
    );
}

function ConnectionCells({
    row,
    indent,
    props,
}: {
    row: Extract<Row, { kind: "connection" }>;
    indent: number;
    props: ConnectionTableProps;
}) {
    const c = row.connection;
    const tag = colorTagVar(c.color_tag);

    return (
        <>
            <td>
                <span className={styles.nameCell} style={{ paddingLeft: indent }}>
                    <span className={styles.chevronSpace} />
                    <EngineIcon engine={c.engine} />
                    <span className={styles.connectionName}>{c.name}</span>
                    {tag && <span className={controls.dot} style={{ background: tag }} />}
                    {props.connected.has(c.id) && (
                        <span
                            className={controls.connectedDot}
                            role="img"
                            aria-label="Connected"
                            {...tooltip("Connected")}
                        />
                    )}
                </span>
            </td>
            <td className={styles.engineCell}>{engineLabel(c, true)}</td>
            <td className={styles.monoCell}>{locationLabel(c, props.home)}</td>
            <td>
                <span className={controls.badge} data-level={c.access_level}>
                    {ACCESS_LABELS[c.access_level]}
                </span>
            </td>
            <td className={styles.monoCell}>{relativeTime(c.last_used_at)}</td>
        </>
    );
}

function DragLabel({ drag }: { drag: DragView }) {
    const { row } = drag;
    return (
        <div className={styles.dragLabel} style={{ left: drag.x + 14, top: drag.y + 10 }} aria-hidden="true">
            <span className={styles.muted}>
                <GripVertical size={13} />
            </span>
            {row.kind === "folder" ? <Folder size={14} /> : <EngineIcon engine={row.connection.engine} />}
            <span className={row.kind === "folder" ? styles.folderName : styles.connectionName}>{rowName(row)}</span>
            {row.kind === "connection" && (
                <span className={controls.badge} data-level={row.connection.access_level}>
                    {ACCESS_LABELS[row.connection.access_level]}
                </span>
            )}
            <span className={styles.spacer} />
            <span className={styles.dragHint}>{drag.move?.label ?? "Can't drop here"}</span>
        </div>
    );
}
