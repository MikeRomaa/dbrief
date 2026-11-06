import { Pin } from "lucide-react";

import { ACCESS_LABELS, colorTagVar, locationLabel } from "@/lib/connectionFormat";
import { type Connection, folderPath, type ItemRef, type TreeIndex } from "@/lib/connectionTree";
import { tooltip } from "@/shell/TooltipLayer";
import { EngineIcon } from "@/ui/EngineIcon";

import styles from "@/connections/ConnectionsView.module.css";
import controls from "@/ui/controls.module.css";

interface PinnedCardsProps {
    pinned: Connection[];
    index: TreeIndex;
    selected: ItemRef | null;
    connected: ReadonlySet<string>;
    home: string | null;
    onSelect: (item: ItemRef) => void;
    onConnect: (connection: Connection) => void;
    onUnpin: (connectionId: string) => void;
}

/** Pinned connections as cards: click selects, double-click or Enter connects. */
export function PinnedCards({
    pinned,
    index,
    selected,
    connected,
    home,
    onSelect,
    onConnect,
    onUnpin,
}: PinnedCardsProps) {
    return (
        <section className={styles.section} aria-labelledby="pinned-label">
            <div className={styles.sectionHeader}>
                <h2 id="pinned-label" className={controls.sectionLabel}>
                    Pinned
                </h2>
                <span className={controls.count}>{pinned.length}</span>
            </div>
            <ul className={styles.cards}>
                {pinned.map((c) => {
                    const path = folderPath(index, c.folder_id).join(" / ");
                    const tag = colorTagVar(c.color_tag);
                    return (
                        <li key={c.id} className={styles.cardItem}>
                            {/* biome-ignore lint/a11y/useSemanticElements: the card holds a nested Unpin button, so it can't be a <button> */}
                            <div
                                role="button"
                                tabIndex={0}
                                className={styles.card}
                                data-selected={selected?.id === c.id || undefined}
                                aria-label={`${c.name}, ${ACCESS_LABELS[c.access_level]}${connected.has(c.id) ? ", connected" : ""}`}
                                onClick={() => onSelect({ kind: "connection", id: c.id })}
                                onDoubleClick={() => onConnect(c)}
                                onKeyDown={(e) => {
                                    if (e.key === "Enter") {
                                        e.preventDefault();
                                        onConnect(c);
                                    } else if (e.key === " ") {
                                        e.preventDefault();
                                        onSelect({ kind: "connection", id: c.id });
                                    }
                                }}
                            >
                                <div className={styles.cardTitle}>
                                    <EngineIcon engine={c.engine} size={16} />
                                    {tag && <span className={controls.dot} style={{ background: tag }} />}
                                    <span className={styles.cardName}>{c.name}</span>
                                    <span className={styles.spacer} />
                                    <button
                                        type="button"
                                        className={controls.iconButton}
                                        aria-label={`Unpin ${c.name}`}
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            onUnpin(c.id);
                                        }}
                                        {...tooltip("Unpin")}
                                    >
                                        <Pin size={13} />
                                    </button>
                                </div>
                                <div className={styles.cardPath}>
                                    <span className={styles.ellipsis}>{path}</span>
                                </div>
                                <div className={styles.cardMeta}>
                                    <span className={controls.badge} data-level={c.access_level}>
                                        {ACCESS_LABELS[c.access_level]}
                                    </span>
                                    <span className={styles.cardHost}>{locationLabel(c, home)}</span>
                                    {connected.has(c.id) && <span className={controls.connectedDot} />}
                                </div>
                            </div>
                        </li>
                    );
                })}
            </ul>
        </section>
    );
}
