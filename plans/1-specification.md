# 1. Specification: High-Level Features

Source: Claude Design project "SQL Editor Views" (round 1), built on the **Contrast** design system. Every view is designed in dark and light themes.

## Platform

- Desktop app built with **Tauri** (Rust backend, web UI).
- Runs on macOS, Windows and Linux.
- SQL editor component: **CodeMirror 6**.
- Shortcuts use ⌘ on macOS and Ctrl on Windows/Linux. This document writes them as ⌘.
- Interface language: English, with strings written inline.

## Privacy

- No telemetry, usage stats or crash reporting. Nothing leaves the machine.
- The app writes local log files that users can attach to bug reports.

## Accessibility

- Full keyboard navigation: every control is reachable without a mouse.
- Screen reader labels (ARIA) on the grid, trees, tabs and dialogs.
- Text and UI contrast meets WCAG AA.
- Animations are turned off when the OS reduced-motion setting is on.

## Supported engines

- PostgreSQL (server, TCP)
- SQLite (local file)

## Data storage

| Data                                                  | Where                                           |
| ----------------------------------------------------- | ----------------------------------------------- |
| Connections, folders, history, schema cache, diagrams | Local SQLite database in the app data directory |
| Settings                                              | `settings.toml` in the app data directory       |
| Passwords and SSH secrets                             | OS credential store (see Connections)           |
| Scripts                                               | Plain `.sql` files in a folder on disk          |

## Updates

- Built-in **Tauri auto-updater** with signed updates.
- Checks for updates on launch; the user approves each install.

## First launch

A short welcome screen asks for:

1. Theme (Light / Dark / System)
2. Scripts folder location
3. Optionally, a connections file to import

Then the app opens the Connections view.

## App shell (layout skeleton)

The app uses a **single window**. The two editor groups cover side-by-side work.

Fixed regions:

| Region        | Size                         | Purpose                                                                                                                     |
| ------------- | ---------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Top bar       | 34px                         | Custom title bar: app name, breadcrumb, window controls (native traffic lights on macOS). Drags the window.                 |
| Activity rail | 44px                         | Switches the side panel: Connections, Explorer, Scripts, History, Diagrams, Settings                                        |
| Side panel    | 248px (resizable 200 to 420) | Whatever the rail selects                                                                                                   |
| Editor groups | flex, min 320px each         | Tabs hold tables, scripts, structure, diagrams. Up to two groups, side by side or stacked. Drag a tab to the edge to split. |
| Bottom panel  | 220px, collapses to 30px     | Results, Staged changes, Log, History. Shared by all groups.                                                                |
| Inspector     | 300px, optional              | Context for the selection: cell value, row details, object properties, connection settings                                  |
| Status bar    | 24px                         | Panel toggles (side panel on the left; bottom panel and inspector on the right), connection, access level, cursor position, staged count, encoding |

Preset compositions: Table editing, Script with inline results, Compare (two groups), Diagram (full-bleed canvas), Focus (editor only).

On relaunch the app restores **open tabs and layout** (tabs, splits, panel sizes).

**Preview tabs:** single-clicking a table, script or history entry opens it in a preview tab (italic title). The next single-click replaces it. Double-clicking or editing pins it as a normal tab.

### Search

Search (⌘P) opens as a popover under the title bar and closes with ⌘P or Esc. It finds connections, tables, columns and scripts. It is search only, not a command palette.

- Search runs against a **local cached index** of each connection's schema (schemas, tables, columns).
- The index refreshes **on connect** and **after any DDL run in the app**.
- Results work with no connections active. Picking a table or column from a disconnected connection connects first (asking for credentials if needed), then opens it.

## Access levels and transactions

Each connection has an **access level**:

| Level | Allows                                 |
| ----- | -------------------------------------- |
| RO    | Reads only                             |
| RW    | Reads and data changes                 |
| DDL   | Reads, data changes and schema changes |

Enforcement uses two layers:

1. **Database side:** RO connections run statements in a read-only transaction/session.
2. **App side:** the app classifies each statement before sending and blocks anything above the connection's level (e.g. `ALTER TABLE` on an RW connection).

Transactions:

- Default mode: **Auto-commit for RO**, **Manual for RW and DDL**. Changeable per connection and per tab.
- Closing a tab or disconnecting with uncommitted work prompts: **Commit / Roll back / Cancel**.
- **Confirm before commit** (per-connection toggle): before committing, show the list of statements and the number of rows each one affected. The user confirms or rolls back.

Sessions and concurrency:

- **One database session per tab.** Each script or table tab has its own session and transaction, so tabs never interfere.
- Queries in different tabs run **in parallel**.
- **Query timeout:** none by default; configurable per connection (Advanced settings).
- **Connection loss:** if the tab had no open transaction, the app reconnects automatically. If a transaction was open, the app says it was lost and the user must acknowledge before reconnecting.

## 1. Connections

- List of all connections, with a **Pinned** section at the top.
- Users create their own **folders** (nestable) to organize connections however they like.
- Each connection has an internal ID. **Names don't need to be unique**; they are labels only.
- Each connection can have a **color tag**. When a tagged connection is active, the top bar and status bar are tinted with its color (e.g. red for production).
- Columns: name, engine + version, host, access, last used.
- Filter by name or host; manual ordering via drag and drop; collapse all.
- New connection menu: pick an engine, from a connection URL, or import from file.
- **Export / import:** connections and folders export to a versioned **TOML** file for sharing with teammates. Exports never include passwords or other secrets.
  - Import always adds the connections as new entries, keeping the file's folder structure under a chosen parent folder.
- **Open SQLite files directly:** drag a database file onto the app, or use the OS "Open with" menu. This creates a connection, or reuses the existing one for that path.
  - "Open with" is registered for `.db`, `.sqlite`, `.sqlite3`, `.db3` and `.s3db`.
- **Removing a connection** deletes everything tied to it: history, diagrams, schema cache and credential store entries.
- **Deleting a folder** deletes the folder, its subfolders and every connection in them, with the same cleanup as above.
- Both actions show a confirm dialog listing what will be deleted (e.g. 3 connections, 412 history entries, 2 diagrams). There is no undo.
- Connection inspector: connect, edit, duplicate, change access level, connection details, safety toggles (confirm before commit, manual transactions), recent queries, remove.
- A connection's access level is fixed for its sessions. Changing it in the inspector takes effect on the next connect; open sessions keep the level they started with.
- Passwords are stored in the OS credential store, never in plain-text config:
  - macOS: Keychain
  - Windows: Credential Manager
  - Linux: Secret Service API (GNOME Keyring, KWallet)
  - No credential store available (e.g. headless Linux): ask for the password on each connect.

## 2. Add connection (modal)

- Engine picker on the left, plus "Paste a connection URL".
- **Placement:** name, folder, access level, color tag.
- **Server:** host, port, database, user, password (with show/hide), save in keychain. Toggle between field entry and URL entry. SQLite takes a file path instead.
- **Security:** SSL mode, CA certificate, SSH tunnel through a bastion host.
- **SSH tunnel authentication:**
  - Pick a host alias from `~/.ssh/config`, or enter details manually
  - Password
  - Private key file, with optional passphrase
  - SSH agent (ssh-agent / Pageant)
  - Passwords and passphrases go in the OS credential store.
- **Advanced:** timeouts, default schema, startup SQL.
- Generated connection URL is shown and can be copied.
- Actions: Test (shows server version and latency), Cancel, Save, Save and connect.

## 3. Table (data grid)

### Explorer

- Side panel tree of database objects, with columns and types. Filter objects.
  - PostgreSQL: schemas → tables / views / functions / sequences.
  - SQLite: tables / views / indexes / triggers. Attached databases appear as extra top-level nodes.
- Tables show **estimated row counts and sizes** from database statistics. An exact count is available on demand.
  - SQLite: estimates come from `sqlite_stat1` when `ANALYZE` has been run. Otherwise no count is shown until the user asks for one.
- Right-click a table: open data, open structure, copy name, copy DDL, add to a saved diagram.

### Table tab

- Sub-views: Data, Columns, Indices, Constraints, Triggers, DDL.
- Columns, Indices, Constraints and Triggers are **read-only**.

### Data grid

- Grid toolbar: WHERE filter, ORDER BY, paging (e.g. 1–50 of 1,284), transaction mode, export.
- Rows are fetched in pages; **page size is configurable**.
- **Columns:** resize (double-click to fit), reorder by dragging, hide/show (remembered per table), click a header to sort (re-queries with ORDER BY), copy column name.
- **Selection and clipboard:**
  - Select a range of cells and copy as TSV
  - Paste a TSV block into cells; pasted values become staged edits
  - Copy rows as INSERT statements or JSON (right-click)
  - Fill down, or set many selected cells to one value at once
- **Find (⌘F):** searches the rows already loaded. Use the WHERE filter to search the whole table.
- **Large and special values:**
  - Long text is truncated in the cell; the inspector shows and edits the full value.
  - Arrays show inline; the inspector edits them as a list.
  - Binary (bytea / BLOB) shows its size (e.g. `<binary 14 kB>`); the inspector shows a hex preview and can download to or upload from a file.
  - Binary values that are PNG or JPEG images show an image preview.
- **Staged editing:** edits, inserts and deletes are staged and marked per row before commit.
- **Row identity:** editing needs a primary key, or else a unique index. Tables with neither are read-only, and the grid says why.
- **Type-aware cell editors** for each data type:
  - Text: inline text input
  - Number: numeric input with validation
  - Boolean: toggle (true / false / NULL)
  - Date: date picker
  - Datetime: date picker plus time input
  - JSON: inspector with JSON / Tree / Raw views, validation, format, revert cell
- Any nullable cell can be set to NULL; inserted rows show column defaults. NULL and default values look different from real values.
- Staged changes bar: count summary, Review SQL, Revert all, Commit (⌘S).
- Commit runs **all staged changes in one transaction**. Any failure rolls back everything, and the changes stay staged.

## 4. Script (SQL editor)

- Scripts are **plain `.sql` files in one scripts folder on disk** (default location, changeable in Settings). Subfolders show as script folders in the side panel, so scripts work with git and other editors.
- Scripts **autosave** after edits.
- Deleting a script moves the file to the OS trash (Trash / Recycle Bin).
- **External changes** (e.g. `git pull`): the app reloads the file silently if the tab has no unsaved edits; otherwise it asks which version to keep.
- Each script tab is bound to **one connection**, chosen in the toolbar.
- Toolbar: Run (⌘⏎), Run all, Explain, Stop, connection + access badge, schema picker, transaction mode, Format.
- **Statement boundaries:** Run executes the statement under the cursor, or the selection if there is one. Statements are split on semicolons, ignoring semicolons inside strings, comments and dollar-quoted bodies.
- Syntax highlighting.
- **Autocomplete** suggests:
  - Schemas, tables and columns (from the cached schema index)
  - SQL keywords and functions for the connection's dialect
  - Table aliases in the current query (e.g. `p.` lists columns of `payments p`)
- **SQL formatting:** Format button and shortcut format the whole script or the selection, following the connection's SQL dialect. Optional format on save (see Settings).
- **Query parameters:** placeholders prompt for values when the statement runs. Values are remembered per script. Supported syntax:
  - `?1`, `?2` (numbered)
  - `:name` (named)
  - `%(name)s` (named)
- **Results shown inline** under each statement (row count and duration per result) by default. A setting moves results to the bottom panel instead. Any inline result can be popped out to the bottom panel or its own tab. Results are fetched in pages of a configurable size.
- Errors show inline with a code and message.
- Running queries show elapsed time and a Cancel button.
- Bottom tabs: Log, History, Explain.

### Log

One **Log** tab in the bottom panel, with filters for each kind of entry:

- Server notices (e.g. Postgres `RAISE NOTICE`, warnings)
- Statement log: statement, rows affected, duration, timestamp
- Transaction events: BEGIN, COMMIT, ROLLBACK, reconnects
- Errors with full detail: code, detail, hint, position
- Background SQL the app runs itself (e.g. loading tables for the schema index, `count(*)` for exact row counts)

### Export

Results and tables export to:

- CSV
- JSON (array of row objects)
- SQL INSERT statements
- Clipboard as TSV (pastes into spreadsheets)

## 5. Explain analyze

- Opens as its own tab for a statement.
- Runs inside a rolled-back transaction.
- **PostgreSQL:** full plan view.
  - Views: Plan (node tree), Table, Raw.
  - Highlight nodes by Duration, Rows, Cost or Buffers.
  - Each node shows exclusive time, % of total, cost, rows and row misestimates (over/under ×).
  - Summary: planning time, execution time, rows. Actions: Re-run, Compare, Export.
  - Node inspector: timings, loops, actual vs planned rows, filter, shared buffers (hit/read).
- **SQLite:** simplified plan tree from `EXPLAIN QUERY PLAN`, with no timing or cost bars.

## 6. History

- Every statement across all connections, grouped by day.
- Filters: text search, All / Reads / Writes / Errors, connection.
- Each entry: time, SQL preview, status, connection, rows + duration, tags (e.g. Grid commit, DDL).
- Selecting an entry opens a preview tab: full SQL, run details (status, connection, folder, start time, duration, rows, transaction, source file:line), and earlier runs of the same statement.
- History stores **SQL and run stats only, no result rows**.
- Actions: Run again, Open in new script, Copy SQL, Remove from history.
- History kept 90 days.

## 7. Diagram (ER diagrams)

- Diagrams are **view-only**: they show the schema but never change it.
- Saved diagrams list, each with a name and tied to a connection. Diagrams are stored in the app database, not as files.
- Table checklist to choose what is on the canvas; "Add related tables" adds every table one foreign key away.
- Canvas: zoom, fit, keys only / all columns, auto-layout, snap to grid. Tables show row counts and columns; relations show 1-to-N.
- Selecting a table highlights its relations. Inspector lists foreign keys with ON DELETE rules and "Referenced by".
- Export: PNG 2x, SVG, Mermaid, DBML, SQL DDL, copy as image.
- Layout saves automatically.

## 8. Settings

- Grouped sections with search: General, Appearance, Editor, Data grid, Safety, Keybindings, Connections, Updates.
- **Appearance:** theme (Light / Dark / System), density (Compact / Default / Comfortable), interface font size, code font, tint bars with the active connection's color tag.
- **Editor:** scripts folder location, show results inline, inline result row limit, autocomplete, format on save.
- **Keybindings:** a default set, and any command can be rebound. Searchable list; conflicts are flagged. Stored in `settings.toml`.
- **Data grid:** page size, date format, JSON truncation length, NULL display style.
- **Updates:** check on launch, install prompt.
- Backed by `settings.toml` (openable). Changes save automatically.

## Cross-cutting themes

- **Safety first:** access levels per connection, staged edits, manual transactions, confirm before commit, connection color tags, read-only explain.
- **Light and dark themes** for every view.
- **Keyboard-driven:** ⌘P search, ⌘⏎ run, ⌘S commit.

## Future work

Ideas from the mockups or discussion that are not being built now.

- MySQL and MariaDB support
- Translations (move inline strings into a catalog)
- "Edit table" modal: change columns, indices, constraints and triggers, generating ALTER SQL to review before running
- Explain suggestions (e.g. "Run ANALYZE", "Draft CREATE INDEX")
- One-click error fixes (e.g. "Run on billing_rw")
- Restoring unsaved script text, connections or staged edits on relaunch
