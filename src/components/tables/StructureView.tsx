import { Check, Copy, KeyRound, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { createSqlViewer } from "@/lib/editor/sqlEditor";
import { backend, errorMessage } from "@/lib/ipc/backend";
import type { ObjectRef_Deserialize, TableStructure } from "@/lib/ipc/bindings";
import { log } from "@/lib/shell/log";
import { tooltip } from "@/lib/shell/tooltip";
import { formatSql } from "@/lib/sql/format";
import type { Dialect } from "@/lib/sql/statements";

import styles from "@/components/tables/TableTab.module.css";
import controls from "@/components/ui/controls.module.css";

export type StructureKind = "columns" | "indices" | "constraints" | "triggers" | "ddl";

/**
 * A table tab's read-only structure views. They load live on the connection's background session
 * the first time one opens (`ensureConnected` connects first if needed), and again on Refresh.
 */
interface StructureViewProps {
    view: StructureKind;
    connectionId: string;
    object: ObjectRef_Deserialize;
    source: string;
    dialect: Dialect;
    ensureConnected: () => Promise<boolean>;
}

export function StructureView({ view, connectionId, object, source, dialect, ensureConnected }: StructureViewProps) {
    const [structure, setStructure] = useState<TableStructure | null>(null);
    const [ddl, setDdl] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);
    const [copied, setCopied] = useState(false);

    const needsDdl = view === "ddl";
    const loaded = needsDdl ? ddl !== null : structure !== null;

    const load = async () => {
        setLoading(true);
        setError(null);
        try {
            if (!(await ensureConnected())) return;
            const started = performance.now();
            if (needsDdl) {
                setDdl(formatSql(await backend.objectDdl(connectionId, object), dialect));
            } else {
                setStructure(await backend.tableStructure(connectionId, object));
            }
            log({
                kind: "background",
                source,
                text: `Loaded ${needsDdl ? "the DDL" : "the structure"} of ${object.schema}.${object.name}`,
                detail: `${Math.round(performance.now() - started)} ms`,
            });
        } catch (e) {
            setError(errorMessage(e));
        } finally {
            setLoading(false);
        }
    };

    // biome-ignore lint/correctness/useExhaustiveDependencies: load once per view kind
    useEffect(() => {
        if (!loaded && !loading) void load();
    }, [needsDdl]);

    const header = (
        <div className={styles.structureBar}>
            <span className={styles.meta}>
                {view === "ddl" ? "DDL" : `${countOf(structure, view)} ${view}`}
                {loading && " · loading…"}
            </span>
            <span className={styles.spacer} />
            {view === "ddl" && ddl !== null && (
                <button
                    type="button"
                    className={controls.ghost}
                    onClick={() => {
                        void navigator.clipboard.writeText(ddl).catch(() => {});
                        setCopied(true);
                        setTimeout(() => setCopied(false), 1500);
                    }}
                >
                    {copied ? <Check size={13} /> : <Copy size={13} />}
                    {copied ? "Copied" : "Copy"}
                </button>
            )}
            <button
                type="button"
                className={controls.iconButton}
                aria-label="Refresh"
                onClick={() => void load()}
                {...tooltip("Refresh")}
            >
                <RefreshCw size={13} />
            </button>
        </div>
    );

    if (error) {
        return (
            <div className={styles.structure}>
                {header}
                <p className={controls.error} role="alert">
                    {error}
                </p>
            </div>
        );
    }

    if (view === "ddl") {
        return (
            <div className={styles.structure}>
                {header}
                {ddl !== null && <SqlViewer text={ddl} dialect={dialect} />}
            </div>
        );
    }

    return (
        <div className={styles.structure}>
            {header}
            <div className={styles.structureScroll}>
                {structure && <StructureTable view={view} structure={structure} />}
            </div>
        </div>
    );
}

/** Formatted DDL in a read-only CodeMirror view. */
function SqlViewer({ text, dialect }: { text: string; dialect: Dialect }) {
    const hostRef = useRef<HTMLDivElement>(null);
    useEffect(() => {
        if (!hostRef.current) return;
        const view = createSqlViewer(hostRef.current, text, dialect);
        return () => view.destroy();
    }, [text, dialect]);
    return <div ref={hostRef} className={styles.ddl} />;
}

function countOf(structure: TableStructure | null, view: StructureKind): number | string {
    if (!structure) return "";
    switch (view) {
        case "columns":
            return structure.columns.length;
        case "indices":
            return structure.indexes.length;
        case "constraints":
            return structure.constraints.length;
        case "triggers":
            return structure.triggers.length;
        default:
            return "";
    }
}

function StructureTable({ view, structure }: { view: Exclude<StructureKind, "ddl">; structure: TableStructure }) {
    const empty = (what: string) => <p className={styles.none}>No {what}.</p>;

    if (view === "columns") {
        return (
            <table className={styles.structureTable} aria-label="Columns">
                <thead>
                    <tr>
                        <th>#</th>
                        <th>Name</th>
                        <th>Type</th>
                        <th>Nullable</th>
                        <th>Default</th>
                        <th>Key</th>
                    </tr>
                </thead>
                <tbody>
                    {structure.columns.map((c, i) => (
                        <tr key={c.name}>
                            <td className={styles.faint}>{i + 1}</td>
                            <td>{c.name}</td>
                            <td className={styles.muted}>{c.type_name}</td>
                            <td>{c.nullable ? "yes" : "no"}</td>
                            <td className={styles.muted}>{c.default_value ?? ""}</td>
                            <td>
                                {c.pk_ordinal != null && (
                                    <span className={styles.keyCell}>
                                        <KeyRound size={11} aria-hidden /> PK
                                        {structure.columns.filter((x) => x.pk_ordinal != null).length > 1 &&
                                            ` ${c.pk_ordinal}`}
                                    </span>
                                )}
                            </td>
                        </tr>
                    ))}
                </tbody>
            </table>
        );
    }

    if (view === "indices") {
        if (structure.indexes.length === 0) return empty("indexes");
        return (
            <table className={styles.structureTable} aria-label="Indices">
                <thead>
                    <tr>
                        <th>Name</th>
                        <th>Columns</th>
                        <th>Unique</th>
                        <th>Definition</th>
                    </tr>
                </thead>
                <tbody>
                    {structure.indexes.map((x) => (
                        <tr key={x.name}>
                            <td>
                                {x.name}
                                {x.primary && <span className={styles.tag}>primary</span>}
                            </td>
                            <td>{x.columns}</td>
                            <td>{x.unique ? "yes" : "no"}</td>
                            <td className={styles.muted}>{x.definition ?? "automatic"}</td>
                        </tr>
                    ))}
                </tbody>
            </table>
        );
    }

    if (view === "constraints") {
        if (structure.constraints.length === 0) return empty("constraints");
        return (
            <table className={styles.structureTable} aria-label="Constraints">
                <thead>
                    <tr>
                        <th>Name</th>
                        <th>Kind</th>
                        <th>Definition</th>
                    </tr>
                </thead>
                <tbody>
                    {structure.constraints.map((c, i) => (
                        // biome-ignore lint/suspicious/noArrayIndexKey: SQLite constraints have no names
                        <tr key={i}>
                            <td className={c.name ? undefined : styles.faint}>{c.name ?? "unnamed"}</td>
                            <td>{c.kind}</td>
                            <td className={styles.muted}>{c.definition}</td>
                        </tr>
                    ))}
                </tbody>
            </table>
        );
    }

    if (structure.triggers.length === 0) return empty("triggers");
    return (
        <table className={styles.structureTable} aria-label="Triggers">
            <thead>
                <tr>
                    <th>Name</th>
                    <th>Enabled</th>
                    <th>Definition</th>
                </tr>
            </thead>
            <tbody>
                {structure.triggers.map((t) => (
                    <tr key={t.name}>
                        <td>{t.name}</td>
                        <td>{t.enabled ? "yes" : "no"}</td>
                        <td className={styles.muted}>{t.definition}</td>
                    </tr>
                ))}
            </tbody>
        </table>
    );
}
