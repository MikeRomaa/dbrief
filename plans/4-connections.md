# 4. Milestone 2: Connections + First Launch

Roadmap: milestone 2 of 9 (`2-roadmap.md`). Builds on milestone 1 (`3-foundation.md`).

## Goal

Users can create, organize, save and connect to PostgreSQL and SQLite databases. First launch shows a welcome screen. SQLite files open by drag-drop and "Open with". Running queries comes in milestone 3; here a connection proves itself with Test and the status bar.

## Done when

- [ ] Add connection modal creates PostgreSQL and SQLite connections, from fields or a pasted URL.
- [ ] Test shows server version and latency, or the error.
- [ ] Connect opens a session; the status bar shows connection name, access level, server version and color tag tint.
- [ ] SSL modes and CA certificate work against a TLS-enabled PostgreSQL.
- [ ] SSH tunnel works with password, private key (with passphrase), SSH agent and `~/.ssh/config` host aliases.
- [ ] Passwords and SSH secrets live only in the OS credential store; falling back to a prompt when no store is available.
- [ ] Connections view: Pinned section, nestable folders, drag-and-drop reorder and move, filter, collapse all, inspector.
- [ ] Remove connection and delete folder show a confirm dialog with counts, then delete everything tied to them.
- [ ] Export and import connections as TOML, without secrets.
- [ ] First launch shows the welcome screen once.
- [ ] Dropping or "Open with" a SQLite file (`.db .sqlite .sqlite3 .db3 .s3db`) creates or reuses a connection.
- [ ] RO connections open read-only sessions at the database level.
- [ ] The statement classifier labels SQL as read / write / DDL (used by milestone 3 to block statements).
- [ ] `cargo test`, `npm test` and `npm run lint` pass.

## Out of scope

- Running user SQL, results, transactions UI, Commit/Rollback prompts (milestone 3)
- Tabs and per-tab sessions in the UI (milestone 3); the session manager is built here
- Schema cache and search (milestone 4)
- "Recent queries" in the connection inspector (needs History, milestone 6); the section shows an empty state

## Design decisions

- **Identity:** every folder and connection has a UUID. Names are labels and don't need to be unique.
- **Secrets:** stored with the `keyring` crate (macOS Keychain, Windows Credential Manager, Linux Secret Service). Entry key: `dbrief/<connection-id>/<kind>`, where kind is `password`, `ssh-password` or `ssh-passphrase`. The app database never stores secrets.
- **No credential store:** detected at startup; secrets are asked for on connect and kept in memory only for that app session.
- **Drivers:** sqlx for PostgreSQL and SQLite.
- **SSH:** `russh` opens a local port forward through the bastion; sqlx connects to `127.0.0.1:<local port>`. `~/.ssh/config` is parsed for host aliases (HostName, User, Port, IdentityFile, ProxyJump not supported at first).
- **Export format:** TOML with a `version = 1` field. Import always adds new entries under a chosen parent folder.
- **Sessions:** `dbrief-core::session` manages sessions keyed by an opaque session ID. Milestone 3 gives each tab its own session; here the UI opens one session per connection for Connect.
- **Classifier:** `sqlparser` crate with the PostgreSQL and SQLite dialects. Unparseable SQL is treated as DDL (most restrictive), so it is only allowed on DDL connections.

## Data model (new migration)

```
folders
  id            uuid  primary key
  parent_id     uuid  null, references folders(id) on delete cascade
  name          text
  sort_order    real

connections
  id               uuid  primary key
  folder_id        uuid  null, references folders(id) on delete cascade
  name             text
  engine           text  -- 'postgres' | 'sqlite'
  access_level     text  -- 'ro' | 'rw' | 'ddl'
  color_tag        text  null
  pinned           bool
  sort_order       real
  -- PostgreSQL
  host, port, database, username   null
  ssl_mode         text  null
  ca_cert_path     text  null
  -- SQLite
  file_path        text  null  -- canonical absolute path
  -- SSH tunnel (null = off)
  ssh              text  null  -- JSON: host alias or host/port/user, auth method, key path
  -- Advanced
  connect_timeout_s, query_timeout_s   null
  default_schema   text  null
  startup_sql      text  null
  -- Safety toggles
  confirm_before_commit  bool
  manual_transactions    bool  -- default: false for RO, true for RW/DDL
  created_at, last_used_at
```

Later tables (history, diagrams, schema cache) reference `connections(id) on delete cascade`, so removing a connection cleans them up automatically.

## Steps

1. **Data model and repository**
   - Migration for `folders` and `connections`.
   - `dbrief-core::connections`: create, update, move, reorder, pin, delete (with counts of what will be removed), list as a tree.
   - cargo tests: tree building, cascade delete, ordering.

2. **Credential store**
   - `dbrief-core::secrets` wrapping `keyring`, with an in-memory fallback.
   - Delete secrets when a connection is removed, including every connection inside a deleted folder.
   - cargo tests use an in-memory mock store.

3. **Connection URLs**
   - Parse and build `postgresql://user@host:port/db?sslmode=…` and SQLite file paths.
   - Used by "Paste a connection URL", the Fields/URL toggle and the copyable generated URL.
   - cargo tests for round-trips and malformed URLs.

4. **Drivers and sessions**
   - `dbrief-core::session`: open, test and close sessions for PostgreSQL and SQLite.
   - RO: PostgreSQL sessions set `default_transaction_read_only = on`; SQLite opens with `mode=ro`.
   - Apply connect timeout, default schema (`search_path`) and startup SQL.
   - Test returns server version and round-trip latency.
   - Reconnect logic: auto-reconnect when no transaction is open; report a lost transaction otherwise (used by milestone 3).
   - cargo tests: SQLite always; PostgreSQL through testcontainers (see Testing).

5. **SSL and SSH tunnel**
   - SSL modes and CA certificate through sqlx's PostgreSQL options.
   - `dbrief-core::ssh`: russh tunnel with password, private key (+ passphrase), SSH agent (ssh-agent on macOS/Linux, Pageant on Windows), and `~/.ssh/config` host aliases.
   - Tunnel lives as long as its session; closed on disconnect.

6. **Statement classifier**
   - `dbrief-core::classify`: split a statement and label it read / write / DDL per dialect.
   - Covers SELECT, WITH, INSERT/UPDATE/DELETE/MERGE, CREATE/ALTER/DROP/TRUNCATE, GRANT/REVOKE, and data-modifying CTEs (`WITH … DELETE`).
   - cargo tests with a table of statements and expected labels.

7. **Tauri commands**
   - Commands for the connection tree, CRUD, move, pin, delete with counts, test, connect, disconnect, import, export.
   - Typed with `tauri-specta`.

8. **Connections view**
   - Pinned section, folder tree with counts, columns (name, engine + version, host, access, last used).
   - Filter by name or host, collapse all, drag-and-drop to reorder and move between folders.
   - New menu: engine, from connection URL, import from file. New folder.
   - Inspector: connect, edit, duplicate, access level, details, safety toggles (confirm before commit, manual transactions), recent queries (empty state), remove.
   - Changing the access level applies on the next connect; open sessions keep their level.
   - Confirm dialogs for remove and folder delete, listing counts.

9. **Add connection modal**
   - Engine list, Paste a connection URL.
   - Placement (name, folder, access level, color tag), Server (fields or URL), Security (SSL, CA certificate, SSH tunnel), Advanced.
   - Save in keychain checkbox; password show/hide.
   - Generated URL with copy; Test, Cancel, Save, Save and connect.
   - The same modal edits existing connections.

10. **Status bar and color tags**
    - Status bar shows the active connection: name, access level, server version.
    - Top bar and status bar tint with the connection's color tag when the Appearance setting is on.
    - Add the setting to `settings.toml` and the Settings view.

11. **Export and import**
    - Export selected folders/connections (or all) to a TOML file; secrets excluded.
    - Import into a chosen parent folder; always adds new entries; secrets asked for on first connect.
    - cargo tests for round-trip and version checking.

12. **First launch**
    - Welcome screen when `ui_state.first_launch_done` is missing.
    - Theme, scripts folder location (saved as `editor.scripts_folder` in `settings.toml`; folder created if missing), optional import.
    - Then open the Connections view.

13. **SQLite file opening**
    - Window drag-drop of supported files.
    - File associations in the Tauri bundle config for `.db .sqlite .sqlite3 .db3 .s3db`.
    - Handle files passed on launch and to an already-running app (single-instance plugin on Windows/Linux, open-file event on macOS).
    - Reuse an existing connection with the same canonical path, else create one at the root of the tree (name = file name, access RW).

14. **Verify**
    - Run through the "Done when" list.
    - Update `2-roadmap.md`: milestone 2 done, milestone 3 next.

## Testing

- PostgreSQL integration tests use the `testcontainers` crate (`testcontainers-modules` postgres image). Each test run starts a container and removes it afterwards.
- Docker must be running. Without Docker, PostgreSQL tests are skipped with a clear message; SQLite and unit tests still run.
- A TLS-enabled container covers the SSL tests; an SSH server container (e.g. `linuxserver/openssh-server`) covers the tunnel tests.

## Open questions

- None.
