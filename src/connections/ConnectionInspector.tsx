import { Folder, FolderPlus, Pencil, Plug, Trash2, Unplug } from "lucide-react";

import { ACCESS_DESCRIPTIONS, ACCESS_LABELS, engineLabel, locationLabel, plural } from "@/lib/connectionFormat";
import { type Connection, type FolderNode, folderPath, type TreeIndex } from "@/lib/connectionTree";
import { EngineIcon } from "@/ui/EngineIcon";
import { Segmented } from "@/ui/Segmented";
import { Switch } from "@/ui/Switch";

import styles from "@/connections/ConnectionsView.module.css";
import controls from "@/ui/controls.module.css";

const ACCESS_OPTIONS = (["ro", "rw", "ddl"] as const).map((value) => ({ value, label: ACCESS_LABELS[value] }));

interface ConnectionInspectorProps {
    connection: Connection;
    index: TreeIndex;
    connected: boolean;
    connecting: boolean;
    home: string | null;
    onConnect: () => void;
    onDisconnect: () => void;
    onEdit: () => void;
    onDuplicate: () => void;
    onChange: (connection: Connection) => void;
    onRemove: () => void;
}

export function ConnectionInspector({
    connection: c,
    index,
    connected,
    connecting,
    home,
    onConnect,
    onDisconnect,
    onEdit,
    onDuplicate,
    onChange,
    onRemove,
}: ConnectionInspectorProps) {
    const path = folderPath(index, c.folder_id).join(" / ");
    const details: [string, string | null | undefined][] =
        c.engine === "sqlite"
            ? [
                  ["Engine", engineLabel(c)],
                  ["File", locationLabel(c, home)],
              ]
            : [
                  ["Engine", engineLabel(c)],
                  ["Host", c.host],
                  ["Port", String(c.port ?? 5432)],
                  ["Database", c.database],
                  ["User", c.username],
                  ["SSL", c.ssl_mode ?? "prefer"],
                  ["SSH", c.ssh ? c.ssh.host : null],
                  ["Timeout", c.connect_timeout_s ? `${c.connect_timeout_s} s` : null],
              ];

    return (
        <aside className={styles.inspector} aria-label={`${c.name} details`}>
            <div className={styles.inspectorSection}>
                <div className={styles.inspectorTitle}>
                    <EngineIcon engine={c.engine} size={20} labelled />
                    <h2 className={styles.inspectorName}>{c.name}</h2>
                    {connected && <span className={controls.connectedDot} role="img" aria-label="Connected" />}
                </div>
                <div className={styles.inspectorPath}>
                    <Folder size={13} />
                    {path || "Top level"}
                </div>
                <div className={styles.inspectorButtons}>
                    {connected ? (
                        <button type="button" className={controls.button} onClick={onDisconnect}>
                            <Unplug size={12} />
                            Disconnect
                        </button>
                    ) : (
                        <button type="button" className={controls.primary} disabled={connecting} onClick={onConnect}>
                            <Plug size={12} />
                            {connecting ? "Connecting…" : "Connect"}
                        </button>
                    )}
                    <button type="button" className={controls.button} onClick={onEdit}>
                        Edit
                    </button>
                    <button type="button" className={controls.button} onClick={onDuplicate}>
                        Duplicate
                    </button>
                </div>
            </div>

            <div className={styles.inspectorSection}>
                <h3 id="access-label" className={controls.sectionLabel}>
                    Access
                </h3>
                <Segmented
                    value={c.access_level}
                    options={ACCESS_OPTIONS}
                    labelledBy="access-label"
                    describedBy="access-description"
                    fill
                    onChange={(level) => onChange({ ...c, access_level: level })}
                />
                <p id="access-description" className={styles.inspectorNote}>
                    {ACCESS_DESCRIPTIONS[c.access_level]}
                    {connected && " Open sessions keep their level until they reconnect."}
                </p>
            </div>

            <dl className={`${styles.inspectorSection} ${styles.details}`}>
                {details
                    .filter(([, value]) => value)
                    .map(([label, value]) => (
                        <div key={label} className={styles.detail}>
                            <dt>{label}</dt>
                            <dd title={value ?? undefined}>{value}</dd>
                        </div>
                    ))}
            </dl>

            <div className={styles.inspectorSection}>
                <h3 className={controls.sectionLabel}>Safety</h3>
                <Switch
                    label="Confirm before commit"
                    checked={c.confirm_before_commit}
                    onChange={(on) => onChange({ ...c, confirm_before_commit: on })}
                />
                <Switch
                    label="Manual transactions"
                    checked={c.manual_transactions}
                    onChange={(on) => onChange({ ...c, manual_transactions: on })}
                />
            </div>

            <div className={`${styles.inspectorSection} ${styles.grow}`}>
                <h3 className={controls.sectionLabel}>Recent queries</h3>
                <p className={styles.inspectorNote}>Queries you run on this connection will appear here.</p>
            </div>

            <div className={styles.inspectorFooter}>
                <button type="button" className={controls.ghostDanger} onClick={onRemove}>
                    <Trash2 size={13} />
                    Remove connection
                </button>
            </div>
        </aside>
    );
}

interface FolderInspectorProps {
    folder: FolderNode;
    index: TreeIndex;
    onNewFolder: () => void;
    onRename: () => void;
    onDelete: () => void;
}

export function FolderInspector({ folder, index, onNewFolder, onRename, onDelete }: FolderInspectorProps) {
    const parentPath = folderPath(index, folder.parent_id).join(" / ");
    const subfolders = countSubfolders(folder);

    return (
        <aside className={styles.inspector} aria-label={`${folder.name} folder`}>
            <div className={styles.inspectorSection}>
                <div className={styles.inspectorTitle}>
                    <Folder size={20} />
                    <h2 className={styles.inspectorName} data-folder>
                        {folder.name}
                    </h2>
                </div>
                <div className={styles.inspectorPath}>
                    <Folder size={13} />
                    {parentPath || "Top level"}
                </div>
                <p className={styles.inspectorNote}>
                    {plural(folder.connection_count, "connection")}
                    {subfolders > 0 && ` in ${plural(subfolders + 1, "folder")}`}
                </p>
                <div className={styles.inspectorButtons}>
                    <button type="button" className={controls.button} onClick={onNewFolder}>
                        <FolderPlus size={12} />
                        New folder inside
                    </button>
                    <button type="button" className={controls.button} onClick={onRename}>
                        <Pencil size={12} />
                        Rename
                    </button>
                </div>
            </div>
            <div className={styles.grow} />
            <div className={styles.inspectorFooter}>
                <button type="button" className={controls.ghostDanger} onClick={onDelete}>
                    <Trash2 size={13} />
                    Delete folder
                </button>
            </div>
        </aside>
    );
}

function countSubfolders(folder: FolderNode): number {
    return folder.children.reduce((n, child) => (child.kind === "folder" ? n + 1 + countSubfolders(child) : n), 0);
}

export function EmptyInspector() {
    return (
        <aside className={styles.inspector} aria-label="Details">
            <p className={styles.inspectorEmpty}>Select a connection or folder to see its details.</p>
        </aside>
    );
}
