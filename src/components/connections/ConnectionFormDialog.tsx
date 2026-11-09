import { open } from "@tauri-apps/plugin-dialog";
import { Check, ChevronDown, ChevronRight, Copy, Eye, EyeOff, Link, TriangleAlert, X } from "lucide-react";
import { type ReactNode, useEffect, useId, useMemo, useRef, useState } from "react";

import { Checkbox } from "@/components/ui/Checkbox";
import { EngineIcon } from "@/components/ui/EngineIcon";
import { Modal } from "@/components/ui/Modal";
import { Segmented } from "@/components/ui/Segmented";
import { Select } from "@/components/ui/Select";
import { Switch } from "@/components/ui/Switch";
import {
    applyUrlParts,
    type ConnectionForm,
    DEFAULT_SSL_MODE,
    emptyForm,
    formFromConnection,
    formProblem,
    SSL_MODES,
    type SshMethod,
    secretChanges,
    suggestedName,
    toInput,
    typedCredentials,
    withAccessLevel,
} from "@/lib/connections/connectionForm";
import { ACCESS_DESCRIPTIONS, ACCESS_LABELS, COLOR_TAGS, ENGINE_NAMES } from "@/lib/connections/connectionFormat";
import type { Connection, ConnectionTree, TreeNode } from "@/lib/connections/connectionTree";
import { backend, type Credentials, errorMessage } from "@/lib/ipc/backend";
import type { AccessLevel, Engine, SavedSecrets, SslMode } from "@/lib/ipc/bindings";
import { tooltip } from "@/lib/shell/tooltip";

import styles from "@/components/connections/ConnectionFormDialog.module.css";
import controls from "@/components/ui/controls.module.css";

/** Extensions offered when picking a SQLite file; same list as `SQLITE_EXTENSIONS` in dbrief-core. */
const SQLITE_EXTENSIONS = ["db", "sqlite", "sqlite3", "db3", "s3db"];

const ENGINES: { engine: Engine; detail: string }[] = [
    { engine: "postgres", detail: "Server, TCP" },
    { engine: "sqlite", detail: "Local file" },
];

const ACCESS_OPTIONS = (["ro", "rw", "ddl"] as const).map((value) => ({ value, label: ACCESS_LABELS[value] }));

const SERVER_MODES = [
    { value: "fields", label: "Fields" },
    { value: "url", label: "URL" },
] as const;
type ServerMode = (typeof SERVER_MODES)[number]["value"];

const SSH_METHODS: { value: SshMethod; label: string }[] = [
    { value: "agent", label: "SSH agent" },
    { value: "private-key", label: "Private key" },
    { value: "password", label: "Password" },
];

type TestState =
    | { kind: "idle" }
    | { kind: "running" }
    | { kind: "ok"; text: string }
    | { kind: "failed"; text: string };

/**
 * Where a new connection starts: its engine, its folder, and whether to begin in URL mode ("Paste a
 * connection URL").
 */
export interface FormStart {
    engine: Engine;
    folderId: string | null;
    urlMode?: boolean;
}

/**
 * Adds a connection, or edits `connection`. `onSaved` gets the saved connection and, for "Save and
 * connect", the secrets typed here to connect with.
 */
interface ConnectionFormDialogProps {
    connection: Connection | null;
    start: FormStart;
    tree: ConnectionTree;
    persistentSecrets: boolean;
    onClose: () => void;
    onSaved: (connection: Connection, connectWith: Credentials | null, warning: string | null) => void;
}

export function ConnectionFormDialog({
    connection,
    start,
    tree,
    persistentSecrets,
    onClose,
    onSaved,
}: ConnectionFormDialogProps) {
    const titleId = useId();
    const editing = connection !== null;
    const [form, setForm] = useState<ConnectionForm>(() =>
        connection ? formFromConnection(connection) : emptyForm(start.engine, start.folderId),
    );
    const [saved, setSaved] = useState<SavedSecrets | null>(null);
    const [serverMode, setServerMode] = useState<ServerMode>(start.urlMode ? "url" : "fields");
    const [urlText, setUrlText] = useState("");
    const [urlNote, setUrlNote] = useState<{ error: boolean; text: string } | null>(null);
    const [generatedUrl, setGeneratedUrl] = useState("");
    const [advancedOpen, setAdvancedOpen] = useState(false);
    const [test, setTest] = useState<TestState>({ kind: "idle" });
    const [saving, setSaving] = useState(false);
    const [copied, setCopied] = useState(false);
    const urlInputRef = useRef<HTMLInputElement>(null);
    const parseSeq = useRef(0);

    const problem = formProblem(form);
    const set = <K extends keyof ConnectionForm>(key: K, value: ConnectionForm[K]) => {
        setForm((f) => ({ ...f, [key]: value }));
        setTest({ kind: "idle" });
    };

    // When editing, find out which secrets are saved; with none saved, "Save in keychain" starts off.
    useEffect(() => {
        if (!connection) return;

        backend
            .savedSecrets(connection.id)
            .then((s) => {
                setSaved(s);
                setForm((f) => ({ ...f, remember: s.password || s.ssh_password || s.ssh_passphrase }));
            })
            .catch(() => {});
    }, [connection]);

    const input = useMemo(() => toInput(form), [form]);
    useEffect(() => {
        let current = true;
        backend
            .buildConnectionUrl(input)
            .then((url) => current && setGeneratedUrl(url))
            .catch(() => {});
        return () => {
            current = false;
        };
    }, [input]);

    useEffect(() => {
        if (start.urlMode) urlInputRef.current?.focus();
    }, [start.urlMode]);

    const switchServerMode = (mode: ServerMode) => {
        if (mode === "url") setUrlText(generatedUrl);
        setUrlNote(null);
        setServerMode(mode);
    };

    const onUrlChange = (text: string) => {
        setUrlText(text);
        setTest({ kind: "idle" });
        const seq = ++parseSeq.current;
        if (!text.trim()) {
            setUrlNote(null);
            return;
        }

        backend
            .parseConnectionUrl(text)
            .then((parts) => {
                if (seq !== parseSeq.current) return;
                setForm((f) => applyUrlParts(f, parts));
                setUrlNote(
                    parts.ignored_params.length > 0
                        ? { error: false, text: `Ignored: ${parts.ignored_params.join(", ")}` }
                        : null,
                );
            })
            .catch((e: unknown) => {
                if (seq === parseSeq.current) setUrlNote({ error: true, text: errorMessage(e) });
            });
    };

    const pasteUrl = () => {
        switchServerMode("url");
        setUrlText("");
        requestAnimationFrame(() => urlInputRef.current?.focus());
    };

    const runTest = async () => {
        setTest({ kind: "running" });
        try {
            const result = await backend.testConnection(connection?.id ?? null, input, typedCredentials(form));
            const latency = result.latency_ms === null ? "" : `, ${Math.round(result.latency_ms)} ms`;
            setTest({ kind: "ok", text: `Connected. ${result.server_version}${latency}` });
        } catch (e) {
            setTest({ kind: "failed", text: errorMessage(e) });
        }
    };

    const save = async (connectAfter: boolean) => {
        setSaving(true);
        try {
            const changes = secretChanges(form, saved, persistentSecrets);
            const result = connection
                ? await backend.updateConnection(connection.id, input, changes)
                : await backend.createConnection(input, changes);
            onSaved(result.connection, connectAfter ? typedCredentials(form) : null, result.warning);
        } catch (e) {
            setTest({ kind: "failed", text: errorMessage(e) });
            setSaving(false);
        }
    };

    const copyUrl = async () => {
        await navigator.clipboard.writeText(generatedUrl).catch(() => {});
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
    };

    const pickFile = async (title: string, extensions?: string[]) => {
        const path = await open({
            title,
            filters: extensions ? [{ name: "SQLite database", extensions }] : undefined,
        });
        return typeof path === "string" ? path : null;
    };

    const postgres = form.engine === "postgres";
    const savedHint = (isSaved: boolean | undefined) =>
        isSaved && persistentSecrets ? "Saved in keychain" : undefined;

    return (
        <Modal labelledBy={titleId} onClose={onClose} className={styles.dialog}>
            <form
                className={styles.frame}
                onSubmit={(e) => {
                    e.preventDefault();
                    if (!problem && !saving) void save(false);
                }}
            >
                <header className={styles.header}>
                    <h2 id={titleId} className={styles.title}>
                        {editing ? `Edit ${connection.name}` : "New connection"}
                    </h2>
                    <span className={styles.spacer} />
                    <button type="button" className={controls.iconButton} aria-label="Close" onClick={onClose}>
                        <X size={14} />
                    </button>
                </header>

                <div className={styles.body}>
                    <nav className={styles.engines} aria-label="Engine">
                        <div className={`${controls.sectionLabel} ${styles.enginesLabel}`} aria-hidden="true">
                            Engine
                        </div>
                        {ENGINES.map(({ engine, detail }) => (
                            <button
                                key={engine}
                                type="button"
                                className={styles.engine}
                                aria-pressed={form.engine === engine}
                                disabled={editing && form.engine !== engine}
                                onClick={() => set("engine", engine)}
                            >
                                <EngineIcon engine={engine} size={18} />
                                <span className={styles.engineText}>
                                    <span className={styles.engineName}>{ENGINE_NAMES[engine]}</span>
                                    <span className={styles.engineDetail}>{detail}</span>
                                </span>
                            </button>
                        ))}
                        <hr className={styles.rule} />
                        <button type="button" className={styles.pasteUrl} onClick={pasteUrl}>
                            <Link size={15} />
                            Paste a connection URL
                        </button>
                    </nav>

                    <div className={styles.sections}>
                        <Section title="Placement">
                            <div className={styles.grid2}>
                                <Field label="Name">
                                    <input
                                        className={`${controls.input} ${styles.mono}`}
                                        value={form.name}
                                        placeholder={suggestedName(form) || undefined}
                                        onChange={(e) => set("name", e.target.value)}
                                        spellCheck={false}
                                        autoComplete="off"
                                    />
                                </Field>
                                <LabelledGroup label="Folder">
                                    {(labelId) => (
                                        <Select
                                            value={form.folderId ?? ""}
                                            options={[
                                                { value: "", label: "None", muted: true },
                                                ...folderOptions(tree.root).map((f) => ({
                                                    value: f.id,
                                                    label: f.path,
                                                })),
                                            ]}
                                            labelledBy={labelId}
                                            onChange={(id) => set("folderId", id || null)}
                                        />
                                    )}
                                </LabelledGroup>
                            </div>
                            <LabelledGroup label="Access">
                                {(labelId) => (
                                    <div className={styles.inline}>
                                        <Segmented
                                            value={form.accessLevel}
                                            options={ACCESS_OPTIONS}
                                            labelledBy={labelId}
                                            onChange={(level: AccessLevel) =>
                                                setForm((f) =>
                                                    editing ? { ...f, accessLevel: level } : withAccessLevel(f, level),
                                                )
                                            }
                                        />
                                        <span className={styles.note}>{ACCESS_DESCRIPTIONS[form.accessLevel]}</span>
                                    </div>
                                )}
                            </LabelledGroup>
                            <LabelledGroup label="Color tag">
                                {(labelId) => (
                                    <ColorTags
                                        labelledBy={labelId}
                                        value={form.colorTag}
                                        onChange={(t) => set("colorTag", t)}
                                    />
                                )}
                            </LabelledGroup>
                        </Section>

                        <Section
                            title={postgres ? "Server" : "File"}
                            action={
                                <Segmented
                                    value={serverMode}
                                    options={SERVER_MODES}
                                    label="Enter as"
                                    onChange={switchServerMode}
                                />
                            }
                        >
                            {serverMode === "url" ? (
                                <Field label={postgres ? "Connection URL" : "File path or URL"}>
                                    <input
                                        ref={urlInputRef}
                                        className={`${controls.input} ${styles.mono}`}
                                        value={urlText}
                                        placeholder={
                                            postgres
                                                ? "postgresql://user@host:5432/database"
                                                : "sqlite:///path/to/file.db"
                                        }
                                        onChange={(e) => onUrlChange(e.target.value)}
                                        spellCheck={false}
                                        autoComplete="off"
                                    />
                                    {urlNote && (
                                        <span className={urlNote.error ? styles.fieldError : styles.note}>
                                            {urlNote.text}
                                        </span>
                                    )}
                                </Field>
                            ) : postgres ? (
                                <div className={styles.row}>
                                    <Field label="Host" grow={3}>
                                        <TextInput value={form.host} onChange={(v) => set("host", v)} />
                                    </Field>
                                    <Field label="Port" grow={1}>
                                        <TextInput
                                            value={form.port}
                                            placeholder="5432"
                                            onChange={(v) => set("port", v)}
                                        />
                                    </Field>
                                    <Field label="Database" grow={2}>
                                        <TextInput value={form.database} onChange={(v) => set("database", v)} />
                                    </Field>
                                </div>
                            ) : (
                                <Field label="Database file">
                                    <PathInput
                                        value={form.filePath}
                                        onChange={(v) => set("filePath", v)}
                                        onBrowse={async () => {
                                            const path = await pickFile("Choose SQLite file", SQLITE_EXTENSIONS);
                                            if (path) set("filePath", path);
                                        }}
                                    />
                                </Field>
                            )}
                            {postgres && (
                                <div className={styles.row}>
                                    {serverMode === "fields" && (
                                        <Field label="User" grow={1}>
                                            <TextInput value={form.username} onChange={(v) => set("username", v)} />
                                        </Field>
                                    )}
                                    <Field label="Password" grow={1}>
                                        <SecretInput
                                            label="password"
                                            value={form.password}
                                            placeholder={savedHint(saved?.password)}
                                            onChange={(v) => set("password", v)}
                                        />
                                    </Field>
                                    <div className={styles.rememberCell}>
                                        {persistentSecrets ? (
                                            <Checkbox checked={form.remember} onChange={(on) => set("remember", on)}>
                                                Save in keychain
                                            </Checkbox>
                                        ) : (
                                            <span className={styles.note}>Kept until DBrief quits</span>
                                        )}
                                    </div>
                                </div>
                            )}
                        </Section>

                        {postgres && (
                            <Section title="Security">
                                <div className={styles.row}>
                                    <LabelledGroup label="SSL mode" grow={1}>
                                        {(labelId) => (
                                            <Select<SslMode | "">
                                                value={form.sslMode ?? ""}
                                                options={[
                                                    { value: "", label: `${DEFAULT_SSL_MODE} (default)`, muted: true },
                                                    ...SSL_MODES.map((mode) => ({ value: mode, label: mode })),
                                                ]}
                                                labelledBy={labelId}
                                                mono
                                                onChange={(mode) => set("sslMode", mode || null)}
                                            />
                                        )}
                                    </LabelledGroup>
                                    <Field label="CA certificate" grow={2}>
                                        <PathInput
                                            value={form.caCertPath}
                                            placeholder="System certificates"
                                            onChange={(v) => set("caCertPath", v)}
                                            onBrowse={async () => {
                                                const path = await pickFile("Choose CA certificate");
                                                if (path) set("caCertPath", path);
                                            }}
                                        />
                                    </Field>
                                </div>
                                <Switch
                                    label="SSH tunnel"
                                    detail="Connect through a bastion host"
                                    checked={form.sshEnabled}
                                    onChange={(on) => set("sshEnabled", on)}
                                />
                                {form.sshEnabled && (
                                    <>
                                        <div className={styles.row}>
                                            <Field label="SSH host or alias" grow={3}>
                                                <TextInput value={form.sshHost} onChange={(v) => set("sshHost", v)} />
                                            </Field>
                                            <Field label="Port" grow={1}>
                                                <TextInput
                                                    value={form.sshPort}
                                                    placeholder="22"
                                                    onChange={(v) => set("sshPort", v)}
                                                />
                                            </Field>
                                            <Field label="User" grow={2}>
                                                <TextInput value={form.sshUser} onChange={(v) => set("sshUser", v)} />
                                            </Field>
                                        </div>
                                        <LabelledGroup label="Sign in with">
                                            {(labelId) => (
                                                <Segmented
                                                    value={form.sshMethod}
                                                    options={SSH_METHODS}
                                                    labelledBy={labelId}
                                                    onChange={(m) => set("sshMethod", m)}
                                                />
                                            )}
                                        </LabelledGroup>
                                        {form.sshMethod === "private-key" && (
                                            <div className={styles.row}>
                                                <Field label="Key file" grow={2}>
                                                    <PathInput
                                                        value={form.sshKeyPath}
                                                        placeholder="IdentityFile from ~/.ssh/config"
                                                        onChange={(v) => set("sshKeyPath", v)}
                                                        onBrowse={async () => {
                                                            const path = await pickFile("Choose private key");
                                                            if (path) set("sshKeyPath", path);
                                                        }}
                                                    />
                                                </Field>
                                                <Field label="Passphrase" grow={1}>
                                                    <SecretInput
                                                        label="passphrase"
                                                        value={form.sshPassphrase}
                                                        placeholder={savedHint(saved?.ssh_passphrase)}
                                                        onChange={(v) => set("sshPassphrase", v)}
                                                    />
                                                </Field>
                                            </div>
                                        )}
                                        {form.sshMethod === "password" && (
                                            <div className={styles.row}>
                                                <Field label="SSH password" grow={1}>
                                                    <SecretInput
                                                        label="SSH password"
                                                        value={form.sshPassword}
                                                        placeholder={savedHint(saved?.ssh_password)}
                                                        onChange={(v) => set("sshPassword", v)}
                                                    />
                                                </Field>
                                                <span className={styles.grow2} />
                                            </div>
                                        )}
                                    </>
                                )}
                            </Section>
                        )}

                        <button
                            type="button"
                            className={styles.advancedToggle}
                            aria-expanded={advancedOpen}
                            onClick={() => setAdvancedOpen((o) => !o)}
                        >
                            {advancedOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                            <span className={styles.advancedTitle}>Advanced</span>
                            {postgres ? "Timeouts, default schema, startup SQL" : "Timeouts, startup SQL"}
                        </button>
                        {advancedOpen && (
                            <Section>
                                <div className={styles.row}>
                                    <Field label="Connect timeout (s)" grow={1}>
                                        <TextInput
                                            value={form.connectTimeout}
                                            placeholder="30"
                                            onChange={(v) => set("connectTimeout", v)}
                                        />
                                    </Field>
                                    <Field label="Query timeout (s)" grow={1}>
                                        <TextInput
                                            value={form.queryTimeout}
                                            placeholder="None"
                                            onChange={(v) => set("queryTimeout", v)}
                                        />
                                    </Field>
                                    {postgres ? (
                                        <Field label="Default schema" grow={1}>
                                            <TextInput
                                                value={form.defaultSchema}
                                                placeholder="public"
                                                onChange={(v) => set("defaultSchema", v)}
                                            />
                                        </Field>
                                    ) : (
                                        <span className={styles.grow1} />
                                    )}
                                </div>
                                <Field label="Startup SQL">
                                    <textarea
                                        className={`${controls.input} ${styles.mono} ${styles.textarea}`}
                                        value={form.startupSql}
                                        placeholder="Runs after every connect, e.g. SET statement_timeout = '5min';"
                                        onChange={(e) => set("startupSql", e.target.value)}
                                        spellCheck={false}
                                        rows={3}
                                    />
                                </Field>
                            </Section>
                        )}

                        <div className={styles.urlStrip}>
                            <span className={styles.urlText} title={generatedUrl}>
                                {generatedUrl}
                            </span>
                            <button
                                type="button"
                                className={controls.iconButton}
                                aria-label={copied ? "Copied" : "Copy connection URL"}
                                onClick={() => void copyUrl()}
                                {...tooltip(copied ? "Copied" : "Copy URL (without the password)", {
                                    placement: "top",
                                })}
                            >
                                {copied ? <Check size={13} /> : <Copy size={13} />}
                            </button>
                        </div>
                    </div>
                </div>

                <footer className={styles.footer}>
                    <TestStatus test={test} problem={problem} />
                    <span className={styles.spacer} />
                    <button
                        type="button"
                        className={controls.button}
                        disabled={problem !== null || test.kind === "running"}
                        onClick={() => void runTest()}
                    >
                        {test.kind === "running" ? "Testing…" : "Test"}
                    </button>
                    <button type="button" className={controls.ghost} onClick={onClose}>
                        Cancel
                    </button>
                    <button type="submit" className={controls.button} disabled={problem !== null || saving}>
                        Save
                    </button>
                    <button
                        type="button"
                        className={controls.primary}
                        disabled={problem !== null || saving}
                        onClick={() => void save(true)}
                    >
                        Save and connect
                    </button>
                </footer>
            </form>
        </Modal>
    );
}

function Section({ title, action, children }: { title?: string; action?: ReactNode; children: ReactNode }) {
    return (
        <section className={styles.section}>
            {title && (
                <div className={styles.sectionHeader}>
                    <h3 className={styles.sectionTitle}>{title}</h3>
                    <span className={styles.spacer} />
                    {action}
                </div>
            )}
            {children}
        </section>
    );
}

function Field({ label, grow, children }: { label: string; grow?: number; children: ReactNode }) {
    return (
        // biome-ignore lint/a11y/noLabelWithoutControl: the input comes in as children
        <label className={styles.field} style={grow ? { flex: grow } : undefined}>
            <span className={controls.sectionLabel}>{label}</span>
            {children}
        </label>
    );
}

/** A label for a group of controls that can't be wrapped in a `<label>`, such as a radio group. */
function LabelledGroup({
    label,
    grow,
    children,
}: {
    label: string;
    grow?: number;
    children: (labelId: string) => ReactNode;
}) {
    const id = useId();
    return (
        <div className={styles.field} style={grow ? { flex: grow } : undefined}>
            <span id={id} className={controls.sectionLabel}>
                {label}
            </span>
            {children(id)}
        </div>
    );
}

function TextInput({
    value,
    placeholder,
    onChange,
}: {
    value: string;
    placeholder?: string;
    onChange: (value: string) => void;
}) {
    return (
        <input
            className={`${controls.input} ${styles.mono}`}
            value={value}
            placeholder={placeholder}
            onChange={(e) => onChange(e.target.value)}
            spellCheck={false}
            autoComplete="off"
            autoCapitalize="off"
        />
    );
}

function SecretInput({
    label,
    value,
    placeholder,
    onChange,
}: {
    label: string;
    value: string;
    placeholder?: string;
    onChange: (value: string) => void;
}) {
    const [visible, setVisible] = useState(false);
    return (
        <span className={styles.withButton}>
            <input
                className={`${controls.input} ${styles.mono}`}
                type={visible ? "text" : "password"}
                value={value}
                placeholder={placeholder}
                onChange={(e) => onChange(e.target.value)}
                spellCheck={false}
                autoComplete="off"
            />
            <button
                type="button"
                className={styles.inlineButton}
                aria-label={visible ? `Hide ${label}` : `Show ${label}`}
                aria-pressed={visible}
                onClick={() => setVisible((v) => !v)}
            >
                {visible ? <EyeOff size={13} /> : <Eye size={13} />}
            </button>
        </span>
    );
}

function PathInput({
    value,
    placeholder,
    onChange,
    onBrowse,
}: {
    value: string;
    placeholder?: string;
    onChange: (value: string) => void;
    onBrowse: () => void;
}) {
    return (
        <span className={styles.withButton}>
            <input
                className={`${controls.input} ${styles.mono}`}
                value={value}
                placeholder={placeholder}
                onChange={(e) => onChange(e.target.value)}
                spellCheck={false}
                autoComplete="off"
            />
            <button type="button" className={styles.inlineText} onClick={onBrowse}>
                Browse
            </button>
        </span>
    );
}

function ColorTags({
    value,
    labelledBy,
    onChange,
}: {
    value: string | null;
    labelledBy: string;
    onChange: (tag: string | null) => void;
}) {
    const options: (string | null)[] = [null, ...COLOR_TAGS];
    return (
        <div role="radiogroup" aria-labelledby={labelledBy} className={styles.tags}>
            {options.map((tag) => (
                // biome-ignore lint/a11y/useSemanticElements: color swatches; follows the WAI-ARIA radio group pattern, like ThemePicker.
                <button
                    key={tag ?? "none"}
                    type="button"
                    role="radio"
                    aria-checked={value === tag}
                    aria-label={tag ?? "None"}
                    className={styles.tag}
                    style={tag ? { background: `var(--tag-${tag})` } : undefined}
                    onClick={() => onChange(tag)}
                    {...tooltip(tag ? tag[0]?.toUpperCase() + tag.slice(1) : "None")}
                >
                    {!tag && <X size={10} />}
                </button>
            ))}
        </div>
    );
}

function TestStatus({ test, problem }: { test: TestState; problem: string | null }) {
    if (test.kind === "ok") {
        return (
            <span className={styles.statusOk} role="status">
                <Check size={13} strokeWidth={2.5} />
                {test.text}
            </span>
        );
    }

    if (test.kind === "failed") {
        return (
            <span className={styles.statusFailed} role="alert" title={test.text}>
                <TriangleAlert size={13} />
                <span className={styles.statusText}>{test.text}</span>
            </span>
        );
    }

    return (
        <span className={styles.statusNote} role="status">
            {problem ?? ""}
        </span>
    );
}

/** Every folder in tree order, labelled with its path ("Billing / Staging"). */
function folderOptions(nodes: TreeNode[], parents: string[] = []): { id: string; path: string }[] {
    return nodes.flatMap((node) => {
        if (node.kind !== "folder") return [];

        const path = [...parents, node.name];
        return [{ id: node.id, path: path.join(" / ") }, ...folderOptions(node.children, path)];
    });
}
