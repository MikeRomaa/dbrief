import type { Connection } from "@/lib/connections/connectionTree";
import type {
    AccessLevel,
    ConnectionInput_Deserialize,
    Credentials_Deserialize,
    Engine,
    SavedSecrets,
    SecretChange,
    SecretChanges_Deserialize,
    SshAuth,
    SslMode,
    UrlParts_Serialize,
} from "@/lib/ipc/bindings";

export type SshMethod = SshAuth["method"];

export interface ConnectionForm {
    engine: Engine;
    name: string;
    folderId: string | null;
    accessLevel: AccessLevel;
    colorTag: string | null;
    host: string;
    port: string;
    database: string;
    username: string;
    password: string;
    sslMode: SslMode | null;
    caCertPath: string;
    filePath: string;
    sshEnabled: boolean;
    sshHost: string;
    sshPort: string;
    sshUser: string;
    sshMethod: SshMethod;
    sshKeyPath: string;
    sshPassword: string;
    sshPassphrase: string;
    connectTimeout: string;
    queryTimeout: string;
    defaultSchema: string;
    startupSql: string;
    confirmBeforeCommit: boolean;
    manualTransactions: boolean;
    remember: boolean;
}

export const SSL_MODES: SslMode[] = ["disable", "allow", "prefer", "require", "verify-ca", "verify-full"];

/** Used when a PostgreSQL connection sets no SSL mode, as in libpq. */
export const DEFAULT_SSL_MODE: SslMode = "prefer";

export function emptyForm(engine: Engine, folderId: string | null): ConnectionForm {
    return {
        engine,
        name: "",
        folderId,
        accessLevel: "rw",
        colorTag: null,
        host: "",
        port: "",
        database: "",
        username: "",
        password: "",
        sslMode: null,
        caCertPath: "",
        filePath: "",
        sshEnabled: false,
        sshHost: "",
        sshPort: "",
        sshUser: "",
        sshMethod: "agent",
        sshKeyPath: "",
        sshPassword: "",
        sshPassphrase: "",
        connectTimeout: "",
        queryTimeout: "",
        defaultSchema: "",
        startupSql: "",
        confirmBeforeCommit: false,
        manualTransactions: true,
        remember: true,
    };
}

const text = (value: string | number | null | undefined) => (value == null ? "" : String(value));

export function formFromConnection(c: Connection): ConnectionForm {
    const ssh = c.ssh;
    return {
        ...emptyForm(c.engine, c.folder_id),
        name: c.name,
        accessLevel: c.access_level,
        colorTag: c.color_tag,
        host: text(c.host),
        port: text(c.port),
        database: text(c.database),
        username: text(c.username),
        sslMode: c.ssl_mode,
        caCertPath: text(c.ca_cert_path),
        filePath: text(c.file_path),
        sshEnabled: ssh !== null,
        sshHost: text(ssh?.host),
        sshPort: text(ssh?.port),
        sshUser: text(ssh?.user),
        sshMethod: ssh?.auth.method ?? "agent",
        sshKeyPath: ssh?.auth.method === "private-key" ? ssh.auth.key_path : "",
        connectTimeout: text(c.connect_timeout_s),
        queryTimeout: text(c.query_timeout_s),
        defaultSchema: text(c.default_schema),
        startupSql: text(c.startup_sql),
        confirmBeforeCommit: c.confirm_before_commit,
        manualTransactions: c.manual_transactions,
    };
}

/** Picking RO turns manual transactions off; RW and DDL turn them on. */
export function withAccessLevel(form: ConnectionForm, accessLevel: AccessLevel): ConnectionForm {
    return { ...form, accessLevel, manualTransactions: accessLevel !== "ro" };
}

/** The file name of a path, for naming SQLite connections. */
export function fileName(path: string): string {
    return path.split(/[\\/]/).filter(Boolean).pop() ?? "";
}

/** The name used when the Name field is left empty: the database, the host, or the file name. */
export function suggestedName(form: ConnectionForm): string {
    if (form.engine === "sqlite") {
        return fileName(form.filePath.trim());
    }

    return form.database.trim() || form.host.trim();
}

export function resolvedName(form: ConnectionForm): string {
    return form.name.trim() || suggestedName(form);
}

const orNull = (value: string) => (value.trim() === "" ? null : value.trim());

/** Whole numbers within `max`, or `undefined` for anything else that was typed. */
function parseWhole(value: string, max: number): number | null | undefined {
    const trimmed = value.trim();
    if (trimmed === "") return null;
    if (!/^\d+$/.test(trimmed)) return undefined;

    const n = Number(trimmed);
    return n <= max ? n : undefined;
}

const PORT_MAX = 65_535;
const SECONDS_MAX = 4_294_967_295;

/** Why the form can't be saved or tested yet, or `null` when it can. */
export function formProblem(form: ConnectionForm): string | null {
    if (form.engine === "sqlite") {
        return form.filePath.trim() ? null : "Choose a database file.";
    }

    if (!form.host.trim()) return "Enter a host.";
    if (parseWhole(form.port, PORT_MAX) === undefined) return "Port must be a number up to 65535.";
    if (form.sshEnabled) {
        if (!form.sshHost.trim()) return "Enter the SSH host or ~/.ssh/config alias.";
        if (parseWhole(form.sshPort, PORT_MAX) === undefined) return "SSH port must be a number up to 65535.";
    }
    if (parseWhole(form.connectTimeout, SECONDS_MAX) === undefined) return "Connect timeout must be whole seconds.";
    if (parseWhole(form.queryTimeout, SECONDS_MAX) === undefined) return "Query timeout must be whole seconds.";

    return null;
}

function sshAuth(form: ConnectionForm): SshAuth {
    switch (form.sshMethod) {
        case "password":
            return { method: "password" };
        case "private-key":
            return { method: "private-key", key_path: form.sshKeyPath.trim() };
        case "agent":
            return { method: "agent" };
    }
}

/**
 * The connection to save or test. Fields of the other engine are dropped. Call only when
 * `formProblem` is `null`.
 */
export function toInput(form: ConnectionForm): ConnectionInput_Deserialize {
    const common = {
        name: resolvedName(form),
        folder_id: form.folderId,
        engine: form.engine,
        access_level: form.accessLevel,
        color_tag: form.colorTag,
        connect_timeout_s: parseWhole(form.connectTimeout, SECONDS_MAX) ?? null,
        query_timeout_s: parseWhole(form.queryTimeout, SECONDS_MAX) ?? null,
        startup_sql: form.startupSql.trim() === "" ? null : form.startupSql,
        confirm_before_commit: form.confirmBeforeCommit,
        manual_transactions: form.manualTransactions,
    };

    if (form.engine === "sqlite") {
        return { ...common, file_path: orNull(form.filePath) };
    }

    return {
        ...common,
        host: orNull(form.host),
        port: parseWhole(form.port, PORT_MAX) ?? null,
        database: orNull(form.database),
        username: orNull(form.username),
        ssl_mode: form.sslMode,
        ca_cert_path: orNull(form.caCertPath),
        default_schema: orNull(form.defaultSchema),
        ssh: form.sshEnabled
            ? {
                  host: form.sshHost.trim(),
                  port: parseWhole(form.sshPort, PORT_MAX) ?? null,
                  user: orNull(form.sshUser),
                  auth: sshAuth(form),
              }
            : null,
    };
}

/** The secrets typed into the form, for Test and for connecting right after saving. */
export function typedCredentials(form: ConnectionForm): Credentials_Deserialize {
    const credentials: Credentials_Deserialize = {};
    if (form.password) credentials.password = form.password;
    if (form.sshPassword) credentials.ssh_password = form.sshPassword;
    if (form.sshPassphrase) credentials.ssh_passphrase = form.sshPassphrase;
    return credentials;
}

/**
 * How each secret changes on save. With "Save in keychain" on, typed secrets are stored and empty
 * fields keep what's saved. With it off, saved secrets are removed and typed ones are only used to
 * connect. Without a persistent store (`persistent` false) typed secrets are kept until the app quits.
 */
export function secretChanges(
    form: ConnectionForm,
    saved: SavedSecrets | null,
    persistent: boolean,
): SecretChanges_Deserialize {
    const store = form.remember || !persistent;
    const change = (typed: string, isSaved: boolean): SecretChange => {
        if (typed && store) return { action: "set", value: typed };
        if (!store && isSaved) return { action: "clear" };
        return { action: "keep" };
    };

    return {
        password: change(form.password, saved?.password ?? false),
        ssh_password: change(form.sshPassword, saved?.ssh_password ?? false),
        ssh_passphrase: change(form.sshPassphrase, saved?.ssh_passphrase ?? false),
    };
}

/**
 * Copies a parsed URL into the form, replacing the engine and its server or file fields. The connect
 * timeout and password only change when the URL has them.
 */
export function applyUrlParts(form: ConnectionForm, parts: UrlParts_Serialize): ConnectionForm {
    return {
        ...form,
        engine: parts.engine ?? form.engine,
        host: text(parts.host),
        port: text(parts.port),
        database: text(parts.database),
        username: text(parts.username),
        sslMode: parts.ssl_mode,
        caCertPath: text(parts.ca_cert_path),
        filePath: text(parts.file_path),
        connectTimeout: parts.connect_timeout_s == null ? form.connectTimeout : String(parts.connect_timeout_s),
        password: parts.password ?? form.password,
    };
}
