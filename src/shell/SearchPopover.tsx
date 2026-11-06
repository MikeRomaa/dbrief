import { Columns3, Database, Eye, FileCode, Search, Table2 } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";

import type { ConnectionsState } from "@/hooks/useConnections";
import { backend } from "@/lib/backend";
import type { ScriptNode, SearchHit } from "@/lib/bindings";
import { folderPath } from "@/lib/connectionTree";
import { rank } from "@/lib/search";
import { displayName, type TableRef } from "@/lib/tableTabs";

import styles from "@/shell/SearchPopover.module.css";

/**
 * Search (⌘P) shown as a popover under the title bar. Finds connections, tables, columns (from the
 * local schema cache, so disconnected connections are found too) and scripts. Opening a table of a
 * disconnected connection connects first; its tab asks for credentials if needed.
 */
interface SearchPopoverProps {
    connections: ConnectionsState;
    scripts: ScriptNode[];
    onOpenConnection: (connectionId: string) => void;
    onOpenTable: (table: TableRef, column?: string) => void;
    onOpenScript: (path: string) => void;
    onClose: () => void;
}

const LIMIT = 8;

interface Result {
    id: string;
    group: "Connections" | "Tables" | "Columns" | "Scripts";
    icon: ReactNode;
    label: string;
    detail: string;
    open: () => void;
}

function scriptPaths(nodes: ScriptNode[], out: string[] = []): string[] {
    for (const node of nodes) {
        if (node.kind === "script") out.push(node.path);
        else scriptPaths(node.children, out);
    }
    return out;
}

export function SearchPopover({
    connections,
    scripts,
    onOpenConnection,
    onOpenTable,
    onOpenScript,
    onClose,
}: SearchPopoverProps) {
    const inputRef = useRef<HTMLInputElement>(null);
    const popoverRef = useRef<HTMLDivElement>(null);
    const [query, setQuery] = useState("");
    const [hits, setHits] = useState<SearchHit[]>([]);
    const [active, setActive] = useState(0);

    // Where focus was before the popover opened; kept from the first run, since a rerun (StrictMode in
    // development) would see the popover's own input.
    const previousRef = useRef<HTMLElement | null>(null);

    useEffect(() => {
        previousRef.current ??= document.activeElement as HTMLElement | null;
        const previous = previousRef.current;
        const popover = popoverRef.current;

        inputRef.current?.focus();

        return () => {
            // Only when the popover really closes (its DOM is gone). StrictMode's rehearsal cleanup
            // keeps the DOM; refocusing there would blur the input, and blurring closes the popover.
            if (popover?.isConnected) return;

            // Return focus to where it was, unless the user moved it by clicking elsewhere.
            const current = document.activeElement;
            if (!current || current === document.body || popover?.contains(current)) {
                previous?.focus();
            }
        };
    }, []);

    // Tables and columns come from the backend's cache; a short pause keeps typing smooth.
    useEffect(() => {
        const q = query.trim();
        if (!q) {
            setHits([]);
            return;
        }
        let cancelled = false;
        const timer = setTimeout(() => {
            backend
                .searchSchema(q, LIMIT)
                .then((found) => !cancelled && setHits(found))
                .catch(() => !cancelled && setHits([]));
        }, 60);
        return () => {
            cancelled = true;
            clearTimeout(timer);
        };
    }, [query]);

    const paths = useMemo(() => scriptPaths(scripts), [scripts]);

    const results = useMemo((): Result[] => {
        const q = query.trim();
        if (!q) return [];
        const list: Result[] = [];
        const nameOf = (id: string) => connections.index.connections.get(id)?.name ?? "removed connection";

        for (const c of rank(connections.index.connections.values(), q, (c) => c.name, LIMIT)) {
            const folder = folderPath(connections.index, c.folder_id).join(" / ");
            list.push({
                id: `c:${c.id}`,
                group: "Connections",
                icon: <Database size={13} />,
                label: c.name,
                detail: [folder, c.engine === "sqlite" ? c.file_path : c.host].filter(Boolean).join(" · "),
                open: () => onOpenConnection(c.id),
            });
        }
        for (const hit of hits) {
            if (!connections.index.connections.has(hit.connection_id)) continue;
            const kind = hit.object_kind === "schema" ? "table" : hit.object_kind;
            const table: TableRef = { connectionId: hit.connection_id, schema: hit.schema, name: hit.table, kind };
            const where = `${nameOf(hit.connection_id)} · ${displayName(hit.schema, hit.table)}`;
            if (hit.kind === "table") {
                list.push({
                    id: `t:${hit.connection_id}:${hit.schema}:${hit.table}`,
                    group: "Tables",
                    icon: kind === "table" ? <Table2 size={13} /> : <Eye size={13} />,
                    label: displayName(hit.schema, hit.table),
                    detail: nameOf(hit.connection_id),
                    open: () => onOpenTable(table),
                });
            } else if (hit.column) {
                const column = hit.column;
                list.push({
                    id: `k:${hit.connection_id}:${hit.schema}:${hit.table}:${column}`,
                    group: "Columns",
                    icon: <Columns3 size={13} />,
                    label: column,
                    detail: `${where}${hit.type_name ? ` · ${hit.type_name}` : ""}`,
                    open: () => onOpenTable(table, column),
                });
            }
        }
        for (const path of rank(paths, q, (p) => p, LIMIT)) {
            list.push({
                id: `p:${path}`,
                group: "Scripts",
                icon: <FileCode size={13} />,
                label: path.slice(path.lastIndexOf("/") + 1),
                detail: path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "",
                open: () => onOpenScript(path),
            });
        }
        return list;
    }, [query, hits, paths, connections.index, onOpenConnection, onOpenTable, onOpenScript]);

    useEffect(() => {
        if (active >= results.length) setActive(0);
    }, [results.length, active]);

    const pick = (result: Result | undefined) => {
        if (!result) return;
        onClose();
        result.open();
    };

    const optionId = (r: Result) => `search-${r.id}`;
    const activeResult = results[active];

    return (
        <div
            ref={popoverRef}
            className={styles.popover}
            role="dialog"
            aria-label="Search"
            onKeyDown={(e) => {
                if (e.key === "Escape") {
                    e.preventDefault();
                    onClose();
                } else if (e.key === "ArrowDown") {
                    e.preventDefault();
                    setActive((a) => Math.min(results.length - 1, a + 1));
                } else if (e.key === "ArrowUp") {
                    e.preventDefault();
                    setActive((a) => Math.max(0, a - 1));
                } else if (e.key === "Enter") {
                    e.preventDefault();
                    pick(activeResult);
                }
            }}
            onBlur={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
                    onClose();
                }
            }}
        >
            <div className={styles.field}>
                <Search size={14} />
                <input
                    ref={inputRef}
                    type="search"
                    className={styles.input}
                    placeholder="Search connections, tables, columns, and scripts"
                    aria-label="Search connections, tables, columns, and scripts"
                    role="combobox"
                    aria-expanded={results.length > 0}
                    aria-controls="search-results"
                    aria-activedescendant={activeResult ? optionId(activeResult) : undefined}
                    spellCheck={false}
                    autoComplete="off"
                    value={query}
                    onChange={(e) => {
                        setQuery(e.target.value);
                        setActive(0);
                    }}
                />
            </div>
            {query.trim() && results.length === 0 && <p className={styles.empty}>No results</p>}
            {results.length > 0 && (
                <div id="search-results" role="listbox" aria-label="Results" className={styles.results}>
                    {results.map((r, i) => (
                        <div key={r.id}>
                            {r.group !== results[i - 1]?.group && (
                                <div className={styles.group} role="presentation">
                                    {r.group}
                                </div>
                            )}
                            {/* biome-ignore lint/a11y/useKeyWithClickEvents: the input handles the keyboard */}
                            <div
                                id={optionId(r)}
                                role="option"
                                tabIndex={-1}
                                aria-selected={i === active}
                                className={styles.result}
                                onMouseMove={() => i !== active && setActive(i)}
                                onMouseDown={(e) => e.preventDefault()}
                                onClick={() => pick(r)}
                            >
                                <span className={styles.icon}>{r.icon}</span>
                                <span className={styles.label}>{r.label}</span>
                                <span className={styles.detail}>{r.detail}</span>
                            </div>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}
