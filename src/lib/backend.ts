import {
    type ActionError,
    type Connected_Serialize,
    type Connection_Serialize,
    type ConnectionInput_Deserialize,
    type ConnectionTree_Serialize,
    type Credentials_Deserialize,
    commands,
    type DeleteCounts,
    type ExportFormat,
    type Folder_Serialize,
    type ItemRef,
    type MoreRows_Serialize,
    type OpenedFile_Serialize,
    type Removed,
    type RunError_Serialize,
    type RunOutput_Serialize,
    type Saved_Serialize,
    type SavedSecrets,
    type ScriptMeta_Serialize,
    type ScriptNode,
    type SecretChanges_Deserialize,
    type SessionInfo,
    type Settings_Serialize,
    type SettingsResponse_Serialize,
    type TestResult,
    type TransactionMode,
    type TransactionState_Serialize,
    type UrlParts_Serialize,
} from "@/lib/bindings";

export type Settings = Settings_Serialize;
export type SettingsResponse = SettingsResponse_Serialize;
export type Credentials = Credentials_Deserialize;

type Result<T, E> = { status: "ok"; data: T } | { status: "error"; error: E };

/** Turns a tauri-specta result into a value, throwing on the error variant. */
async function unwrap<T>(result: Promise<Result<T, string>>): Promise<T> {
    const r = await result;
    if (r.status === "error") {
        throw new Error(r.error);
    }

    return r.data;
}

/**
 * A failed connection command. `error.kind` is `secret-required` when the UI should ask for
 * `error.secret` and retry.
 */
export class ActionFailure extends Error {
    readonly error: ActionError;

    constructor(error: ActionError) {
        super(error.message);
        this.name = "ActionFailure";
        this.error = error;
    }
}

async function unwrapAction<T>(result: Promise<Result<T, ActionError>>): Promise<T> {
    const r = await result;
    if (r.status === "error") {
        throw new ActionFailure(r.error);
    }

    return r.data;
}

/** A failed statement or transaction command; `error.kind` says what kind (see `RunError`). */
export class RunFailure extends Error {
    readonly error: RunError_Serialize;

    constructor(error: RunError_Serialize) {
        super(error.kind === "query" ? error.error.message : error.message);
        this.name = "RunFailure";
        this.error = error;
    }
}

async function unwrapRun<T>(result: Promise<Result<T, RunError_Serialize>>): Promise<T> {
    const r = await result;
    if (r.status === "error") {
        throw new RunFailure(r.error);
    }

    return r.data;
}

/** The message of any error, for showing to the user. */
export function errorMessage(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
}

export const backend = {
    getSettings: (): Promise<SettingsResponse> => unwrap(commands.getSettings()),
    updateSettings: (settings: Settings): Promise<SettingsResponse> => unwrap(commands.updateSettings(settings)),
    getUiState: (key: string): Promise<string | null> => unwrap(commands.getUiState(key)),
    setUiState: (key: string, value: string): Promise<null> => unwrap(commands.setUiState(key, value)),
    defaultScriptsFolder: (): Promise<string> => unwrap(commands.defaultScriptsFolder()),
    createScriptsFolder: (path: string): Promise<null> => unwrap(commands.createScriptsFolder(path)),

    connectionTree: (): Promise<ConnectionTree_Serialize> => unwrapAction(commands.connectionTree()),
    getConnection: (id: string): Promise<Connection_Serialize> => unwrapAction(commands.getConnection(id)),
    savedSecrets: (id: string): Promise<SavedSecrets> => commands.savedSecrets(id),
    secretStorePersistent: (): Promise<boolean> => commands.secretStorePersistent(),
    createFolder: (name: string, parentId: string | null): Promise<Folder_Serialize> =>
        unwrapAction(commands.createFolder(name, parentId)),
    renameFolder: (id: string, name: string): Promise<null> => unwrapAction(commands.renameFolder(id, name)),
    createConnection: (
        input: ConnectionInput_Deserialize,
        secrets: SecretChanges_Deserialize,
    ): Promise<Saved_Serialize> => unwrapAction(commands.createConnection(input, secrets)),
    updateConnection: (
        id: string,
        input: ConnectionInput_Deserialize,
        secrets: SecretChanges_Deserialize = {},
    ): Promise<Saved_Serialize> => unwrapAction(commands.updateConnection(id, input, secrets)),
    testConnection: (
        id: string | null,
        input: ConnectionInput_Deserialize,
        prompted: Credentials,
    ): Promise<TestResult> => unwrapAction(commands.testConnection(id, input, prompted)),
    parseConnectionUrl: (text: string): Promise<UrlParts_Serialize> => unwrapAction(commands.parseConnectionUrl(text)),
    buildConnectionUrl: (input: ConnectionInput_Deserialize): Promise<string> => commands.buildConnectionUrl(input),
    duplicateConnection: (id: string): Promise<Saved_Serialize> => unwrapAction(commands.duplicateConnection(id)),
    moveItem: (item: ItemRef, parentId: string | null, before: ItemRef | null): Promise<null> =>
        unwrapAction(commands.moveItem(item, parentId, before)),
    setPinned: (id: string, pinned: boolean): Promise<null> => unwrapAction(commands.setPinned(id, pinned)),
    deleteCounts: (item: ItemRef): Promise<DeleteCounts> => unwrapAction(commands.deleteCounts(item)),
    removeItem: (item: ItemRef): Promise<Removed> => unwrapAction(commands.removeItem(item)),
    connect: (id: string, prompted: Credentials, remember: boolean): Promise<Connected_Serialize> =>
        unwrapAction(commands.connect(id, prompted, remember)),
    disconnect: (sessionId: string): Promise<null> => unwrapAction(commands.disconnect(sessionId)),
    listSessions: (): Promise<SessionInfo[]> => unwrapAction(commands.listSessions()),
    openSqliteFile: (path: string): Promise<OpenedFile_Serialize> => unwrapAction(commands.openSqliteFile(path)),

    scriptTree: (): Promise<ScriptNode[]> => unwrap(commands.scriptTree()),
    readScript: (path: string): Promise<string> => unwrap(commands.readScript(path)),
    writeScript: (path: string, text: string): Promise<null> => unwrap(commands.writeScript(path, text)),
    createScript: (dir: string): Promise<string> => unwrap(commands.createScript(dir)),
    createScriptFolder: (dir: string, name: string): Promise<string> => unwrap(commands.createScriptFolder(dir, name)),
    renameScript: (from: string, to: string): Promise<null> => unwrap(commands.renameScript(from, to)),
    deleteScript: (path: string): Promise<null> => unwrap(commands.deleteScript(path)),
    scriptMeta: (path: string): Promise<ScriptMeta_Serialize> => unwrap(commands.scriptMeta(path)),
    setScriptConnection: (path: string, connectionId: string | null): Promise<null> =>
        unwrap(commands.setScriptConnection(path, connectionId)),
    setScriptSchema: (path: string, schema: string | null): Promise<null> =>
        unwrap(commands.setScriptSchema(path, schema)),
    rememberScriptParams: (path: string, values: Record<string, string | null>): Promise<null> =>
        unwrap(commands.rememberScriptParams(path, values)),

    runStatement: (sessionId: string, sql: string, pageSize: number): Promise<RunOutput_Serialize> =>
        unwrapRun(commands.runStatement(sessionId, sql, pageSize)),
    fetchMore: (sessionId: string): Promise<MoreRows_Serialize> => unwrapRun(commands.fetchMore(sessionId)),
    closeResult: (sessionId: string): Promise<null> => unwrapRun(commands.closeResult(sessionId)),
    cancelStatement: (sessionId: string): Promise<null> => unwrapRun(commands.cancelStatement(sessionId)),
    transactionState: (sessionId: string): Promise<TransactionState_Serialize> =>
        unwrapRun(commands.transactionState(sessionId)),
    setTransactionMode: (sessionId: string, mode: TransactionMode): Promise<null> =>
        unwrapRun(commands.setTransactionMode(sessionId, mode)),
    commit: (sessionId: string): Promise<null> => unwrapRun(commands.commit(sessionId)),
    rollback: (sessionId: string): Promise<null> => unwrapRun(commands.rollback(sessionId)),
    acknowledgeLostTransaction: (sessionId: string): Promise<null> =>
        unwrapRun(commands.acknowledgeLostTransaction(sessionId)),
    setSessionSchema: (sessionId: string, schema: string | null): Promise<null> =>
        unwrapRun(commands.setSessionSchema(sessionId, schema)),
    exportResult: (
        sessionId: string,
        sql: string,
        format: ExportFormat,
        path: string,
        table: string,
    ): Promise<number> =>
        unwrapRun(commands.exportResult(sessionId, sql, format, path, table)).then((rows) => rows ?? 0),
};
