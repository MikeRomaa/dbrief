import { describe, expect, it } from "vitest";

import {
    applyUrlParts,
    type ConnectionForm,
    emptyForm,
    fileName,
    formFromConnection,
    formProblem,
    resolvedName,
    secretChanges,
    toInput,
    typedCredentials,
    withAccessLevel,
} from "@/lib/connectionForm";
import type { Connection } from "@/lib/connectionTree";

const pg = (extra: Partial<ConnectionForm> = {}): ConnectionForm => ({
    ...emptyForm("postgres", null),
    host: "db.internal",
    ...extra,
});

describe("toInput", () => {
    it("trims, parses numbers and drops empty fields", () => {
        const input = toInput(
            pg({
                name: " billing ",
                port: "6432",
                database: "billing",
                username: "",
                connectTimeout: "15",
                defaultSchema: "  ",
                filePath: "/ignored.db",
            }),
        );

        expect(input).toMatchObject({
            name: "billing",
            engine: "postgres",
            host: "db.internal",
            port: 6432,
            database: "billing",
            username: null,
            connect_timeout_s: 15,
            default_schema: null,
            ssh: null,
        });
        expect(input).not.toHaveProperty("file_path");
    });

    it("keeps only the file for SQLite", () => {
        const input = toInput({ ...emptyForm("sqlite", "f1"), filePath: "/data/app.db", host: "ignored" });
        expect(input).toMatchObject({ name: "app.db", folder_id: "f1", file_path: "/data/app.db" });
        expect(input).not.toHaveProperty("host");
    });

    it("builds the SSH tunnel", () => {
        const input = toInput(
            pg({ sshEnabled: true, sshHost: "bastion", sshMethod: "private-key", sshKeyPath: " ~/.ssh/id " }),
        );
        expect(input.ssh).toEqual({
            host: "bastion",
            port: null,
            user: null,
            auth: { method: "private-key", key_path: "~/.ssh/id" },
        });
    });
});

describe("validation and naming", () => {
    it("names connections after the database, host or file", () => {
        expect(resolvedName(pg())).toBe("db.internal");
        expect(resolvedName(pg({ database: "billing" }))).toBe("billing");
        expect(resolvedName(pg({ name: "mine", database: "billing" }))).toBe("mine");
        expect(fileName("C:\\data\\shop.sqlite3")).toBe("shop.sqlite3");
    });

    it("reports what is missing or malformed", () => {
        expect(formProblem(pg())).toBeNull();
        expect(formProblem(pg({ host: " " }))).toMatch(/host/);
        expect(formProblem(pg({ port: "70000" }))).toMatch(/Port/);
        expect(formProblem(pg({ port: "54a" }))).toMatch(/Port/);
        expect(formProblem(pg({ connectTimeout: "1.5" }))).toMatch(/timeout/);
        expect(formProblem(pg({ sshEnabled: true }))).toMatch(/SSH host/);
        expect(formProblem(emptyForm("sqlite", null))).toMatch(/file/);
    });

    it("ties manual transactions to the access level", () => {
        expect(withAccessLevel(pg(), "ro").manualTransactions).toBe(false);
        expect(withAccessLevel(pg({ manualTransactions: false }), "ddl").manualTransactions).toBe(true);
    });
});

describe("secrets", () => {
    const nothingSaved = { password: false, ssh_password: false, ssh_passphrase: false };
    const passwordSaved = { ...nothingSaved, password: true };

    it("stores typed secrets and keeps saved ones when left empty", () => {
        expect(secretChanges(pg({ password: "pw" }), nothingSaved, true)).toEqual({
            password: { action: "set", value: "pw" },
            ssh_password: { action: "keep" },
            ssh_passphrase: { action: "keep" },
        });
        expect(secretChanges(pg(), passwordSaved, true).password).toEqual({ action: "keep" });
    });

    it("clears saved secrets when not saving to the keychain", () => {
        const form = pg({ password: "pw", remember: false });
        expect(secretChanges(form, passwordSaved, true).password).toEqual({ action: "clear" });
        expect(secretChanges(form, nothingSaved, true).password).toEqual({ action: "keep" });
    });

    it("always keeps typed secrets for the session without a keychain", () => {
        expect(secretChanges(pg({ password: "pw", remember: false }), null, false).password).toEqual({
            action: "set",
            value: "pw",
        });
    });

    it("passes typed secrets to Test", () => {
        expect(typedCredentials(pg({ password: "pw", sshPassphrase: "pp" }))).toEqual({
            password: "pw",
            ssh_passphrase: "pp",
        });
    });
});

describe("URLs and existing connections", () => {
    it("applies a parsed URL", () => {
        const form = applyUrlParts(pg({ connectTimeout: "9", password: "old", database: "x" }), {
            engine: "postgres",
            host: "h",
            port: 5433,
            database: null,
            username: "u",
            password: null,
            ssl_mode: "require",
            ca_cert_path: null,
            connect_timeout_s: null,
            file_path: null,
            ignored_params: [],
        });

        expect(form).toMatchObject({
            host: "h",
            port: "5433",
            database: "",
            username: "u",
            sslMode: "require",
            connectTimeout: "9",
            password: "old",
        });
    });

    it("loads a saved connection", () => {
        const connection = {
            id: "c1",
            name: "billing",
            folder_id: "f1",
            engine: "postgres",
            access_level: "ro",
            color_tag: "red",
            host: "db",
            port: 5432,
            database: "billing",
            username: "app",
            ssl_mode: "verify-full",
            ca_cert_path: null,
            file_path: null,
            ssh: { host: "bastion", port: 2222, user: null, auth: { method: "private-key", key_path: "~/k" } },
            connect_timeout_s: 30,
            query_timeout_s: null,
            default_schema: null,
            startup_sql: null,
            confirm_before_commit: true,
            manual_transactions: false,
            pinned: false,
            sort_order: 0,
            created_at: "",
            last_used_at: null,
            server_version: null,
        } satisfies Connection;

        const form = formFromConnection(connection);
        expect(form).toMatchObject({
            port: "5432",
            sshEnabled: true,
            sshPort: "2222",
            sshMethod: "private-key",
            sshKeyPath: "~/k",
            connectTimeout: "30",
            password: "",
        });
        expect(toInput(form)).toMatchObject({ name: "billing", access_level: "ro", ssl_mode: "verify-full" });
    });
});
