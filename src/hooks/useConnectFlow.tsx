import { type ReactNode, useRef, useState } from "react";

import { SecretPrompt } from "@/connections/dialogs";
import { ActionFailure, backend, type Credentials, errorMessage } from "@/lib/backend";
import type { SecretKind, SessionInfo } from "@/lib/bindings";
import type { Connection } from "@/lib/connectionTree";

const SECRET_FIELDS: Record<SecretKind, keyof Credentials> = {
    password: "password",
    "ssh-password": "ssh_password",
    "ssh-passphrase": "ssh_passphrase",
};

interface Prompt {
    connection: Connection;
    secret: SecretKind;
    problem: string | null;
    prompted: Credentials;
    resolve: (session: SessionInfo | null) => void;
}

/**
 * Opens a session for a connection, asking for a password or passphrase when one is needed (render
 * `prompt`). `connect` resolves to the session, or `null` when the user cancels or it fails; failures
 * go to `onError`. `prompted` passes secrets already typed elsewhere (the connection form).
 */
export function useConnectFlow(
    persistentSecrets: boolean,
    onError: (message: string) => void,
): {
    connect: (connection: Connection, prompted?: Credentials) => Promise<SessionInfo | null>;
    prompt: ReactNode;
} {
    const [prompt, setPrompt] = useState<Prompt | null>(null);
    const onErrorRef = useRef(onError);
    onErrorRef.current = onError;

    const attempt = async (
        connection: Connection,
        prompted: Credentials,
        remember: boolean,
        resolve: (session: SessionInfo | null) => void,
    ) => {
        try {
            const result = await backend.connect(connection.id, prompted, remember);
            if (result.warning) onErrorRef.current(result.warning);
            resolve(result.session);
        } catch (e) {
            if (e instanceof ActionFailure && e.error.kind === "secret-required") {
                const { secret, message } = e.error;
                // Only call it a failure when a secret was actually tried: typed, or stored.
                const saved = await backend.savedSecrets(connection.id).catch(() => null);
                const savedFlag =
                    secret === "password"
                        ? saved?.password
                        : secret === "ssh-password"
                          ? saved?.ssh_password
                          : saved?.ssh_passphrase;
                const tried = prompted[SECRET_FIELDS[secret]] != null || savedFlag === true;
                setPrompt({ connection, secret, problem: tried ? message : null, prompted, resolve });
            } else {
                onErrorRef.current(errorMessage(e));
                resolve(null);
            }
        }
    };

    const connect = (connection: Connection, prompted: Credentials = {}) =>
        new Promise<SessionInfo | null>((resolve) => void attempt(connection, prompted, false, resolve));

    const element = prompt && (
        <SecretPrompt
            connectionName={prompt.connection.name}
            secret={prompt.secret}
            problem={prompt.problem}
            canRemember={persistentSecrets}
            onClose={() => {
                setPrompt(null);
                prompt.resolve(null);
            }}
            onSubmit={(value, remember) => {
                setPrompt(null);
                const prompted = { ...prompt.prompted, [SECRET_FIELDS[prompt.secret]]: value };
                void attempt(prompt.connection, prompted, remember, prompt.resolve);
            }}
        />
    );

    return { connect, prompt: element };
}
