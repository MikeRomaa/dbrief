import { useState } from "react";

import { useStore } from "@/hooks/useStore";
import { clearLog, LOG_KINDS, type LogKind, logStore } from "@/lib/shell/log";

import styles from "@/components/shell/LogPanel.module.css";
import controls from "@/components/ui/controls.module.css";

const time = (d: Date) => d.toLocaleTimeString(undefined, { hour12: false });

/** The Log tab: statements, notices, transaction events, errors and background SQL, filterable by kind. */
export function LogPanel() {
    const entries = useStore(logStore);
    const [hidden, setHidden] = useState<ReadonlySet<LogKind>>(new Set());

    const toggle = (kind: LogKind) => {
        const next = new Set(hidden);
        if (next.has(kind)) next.delete(kind);
        else next.add(kind);
        setHidden(next);
    };

    const shown = entries.filter((e) => !hidden.has(e.kind));

    return (
        <div className={styles.panel}>
            <fieldset className={styles.filters}>
                <legend className="visually-hidden">Show</legend>
                {LOG_KINDS.map(({ kind, label }) => (
                    <button
                        key={kind}
                        type="button"
                        className={styles.filter}
                        aria-pressed={!hidden.has(kind)}
                        onClick={() => toggle(kind)}
                    >
                        {label}
                        <span className={controls.count}>{entries.filter((e) => e.kind === kind).length}</span>
                    </button>
                ))}
                <span className={styles.spacer} />
                <button type="button" className={controls.ghost} onClick={clearLog} disabled={entries.length === 0}>
                    Clear
                </button>
            </fieldset>
            <ol className={styles.entries} aria-live="polite">
                {shown.map((e) => (
                    <li key={e.id} className={styles.entry} data-kind={e.kind}>
                        <span className={styles.time}>{time(e.at)}</span>
                        <span className={styles.kind}>{e.kind}</span>
                        <span className={styles.source} title={e.source}>
                            {e.source}
                        </span>
                        <span className={styles.text}>
                            {e.text}
                            {e.detail && <span className={styles.detail}>{e.detail}</span>}
                        </span>
                    </li>
                ))}
                {shown.length === 0 && <li className={styles.empty}>Nothing logged yet.</li>}
            </ol>
        </div>
    );
}
