# 5. Milestone 3: Script Editor

Roadmap: milestone 3 of 9 (`2-roadmap.md`). Builds on milestone 2 (`4-connections.md`).

## Goal

Users write SQL in script tabs and run it against a connection. Results show inline under each statement, with paging, parameters, formatting, transactions and the Log tab. Scripts are plain `.sql` files in the scripts folder. This is the app's SQL console; the table view follows in milestone 4.

## Done when

- [ ] The Scratchpad, at the top of the Scripts panel, runs SQL without a file and keeps its text in the app database.
- [ ] The Scripts side panel lists the scripts folder (subfolders included) and creates, renames, moves and deletes scripts (delete moves to the OS trash).
- [ ] Scripts open in tabs (preview tab on single click, pinned on double click or edit), autosave, and reopen on relaunch.
- [ ] External changes reload silently, or ask which version to keep when the tab has unsaved edits.
- [ ] Each script tab is bound to one connection, picked in the toolbar, with its own session.
- [ ] Run (⌘⏎) runs the statement under the cursor or the selection; Run all runs every statement in order; Stop cancels.
- [ ] Statements are split on semicolons, ignoring strings, comments and dollar-quoted bodies.
- [ ] Results show inline: columns, rows, row count and duration, with more rows fetched in pages; errors show inline with code and message.
- [ ] Results can move to the bottom panel (setting) and any result can be popped out to the bottom panel or its own tab.
- [ ] Statements above the connection's access level are blocked before they are sent (statement classifier).
- [ ] Transactions: auto-commit or manual per connection and per tab; Commit (⌘S) and Roll back; confirm before commit lists statements and rows affected; closing a tab or disconnecting with uncommitted work asks Commit / Roll back / Cancel.
- [ ] A lost connection reconnects on its own without an open transaction, and asks to be acknowledged with one.
- [ ] Query parameters (`?1`, `:name`, `%(name)s`) prompt for values, remembered per script.
- [ ] Format formats the script or selection for the connection's dialect; optional format on save.
- [ ] Syntax highlighting and autocomplete for keywords, functions and table aliases.
- [ ] The Log tab shows server notices, statements, transaction events, errors with full detail, and background SQL, with a filter per kind.
- [ ] Results export to CSV, JSON and SQL INSERT, and copy as TSV.
- [ ] Settings → Editor: show results inline, inline result row limit, autocomplete, format on save. Settings → Data grid: page size.
- [ ] `cargo test`, `npm test` and `npm run lint` pass.

## Out of scope

- Table tabs, the Explorer and schema cache (milestone 4). The mockup's schema section in the side panel arrives with them.
- Autocomplete of schemas, tables and columns (needs the schema cache, milestone 4)
- Active connection in the status bar and color tag tint (milestone 4, though script tabs would allow it here)
- Two editor groups and dragging tabs to split (later; this milestone has one group)
- Explain (milestone 8); the toolbar button is shown disabled
- History (milestone 6); statements are only in the Log tab until then
- The mockup's bottom panel tab names (Output, Messages); the panel keeps Results, Staged changes, Log and History
- One-click fixes such as "Run on billing_rw" (future work in the spec)

## Design decisions

- **Editor:** CodeMirror 6 with `@codemirror/lang-sql` (PostgreSQL and SQLite dialects). Inline results are block widget decorations under each statement, so they scroll with the text. Highlighting uses the `--syntax-*` tokens.
- **Statement splitting runs in TypeScript.** The editor needs the statement under the cursor on every keystroke; a tokenizer that knows strings (`'…'`, `E'…'`), quoted identifiers, `--` and nested `/* */` comments and `$tag$` bodies splits the text and finds placeholders. The backend runs one statement at a time and never splits.
- **Classifier in Rust:** `sqlparser` with the PostgreSQL and SQLite dialects labels each statement read / write / DDL before it is sent. Unparseable SQL counts as DDL. Data-modifying CTEs (`WITH … DELETE`) are writes. `EXPLAIN ANALYZE` takes its inner statement's label. Transaction control, `SHOW` and session `SET` are reads; `CALL`, `DO`, `VACUUM` and `COPY … FROM` are writes.
- **Results:** PostgreSQL statements run over the simple query protocol, as `psql` does, so every value arrives as text and displays without per-type decoding. SQLite values are shown by storage class (integers and reals as numbers, BLOBs as a hex preview with their size). Cells cross IPC as text or null, with column names and database type names. A statement that returns no rows is described afterwards so an empty `SELECT` still shows its columns.
- **Paging:** each statement runs in its own task, which owns the connection while its result is open; "Load more" asks it for the next page (page size from Settings → Data grid). Running anything else on that session closes the open result and takes the connection back.
- **Parameters:** values replace the placeholders as quoted literals (`'it''s'`, or NULL), as `psql` does for `:'name'`. A quoted literal has no fixed type, so PostgreSQL converts it from context (`id = '42'`) and SQLite applies column affinity. (Bound parameters don't work here: sqlx sends them in binary, so text values can't stand in for other types.)
- **Transactions:** in manual mode the app sends `BEGIN` before the first statement that needs a transaction and keeps it open until Commit or Roll back. Explicit `BEGIN` / `COMMIT` / `ROLLBACK` typed by the user update the same state. The per-tab mode starts from the connection's setting.
- **Cancel and timeouts:** PostgreSQL cancels with `pg_cancel_backend` on a second short-lived connection (through the same tunnel); the session's backend pid is read at connect. SQLite cancels through a progress handler that checks an interrupt flag. Cancelling doesn't need the session's lock. The connection's query timeout is a timer that cancels, on both engines.
- **Notices:** sqlx reports PostgreSQL notices only as `tracing` events, so each statement's task runs with its own collector and the notices come back with its result.
- **Scripts on disk:** the scripts folder is the source of truth. A file watcher (`notify`) reports changes; deletes go through the `trash` crate. Autosave writes atomically (temp file and rename) after a short pause in typing.
- **Scratchpad:** one SQL scratch area at the top of the Scripts panel, for trying things without a file. Its text is saved in the app database (`ui_state`) as you type; its connection, schema and parameters use the script metadata table under the key `/scratchpad` (file paths are relative and never start with `/`). It opens as a normal tab and runs like a script.
- **Script metadata** (bound connection, schema, remembered parameter values) lives in the app database, keyed by the script's path relative to the scripts folder. Renames and moves in the app carry it along; files moved outside the app lose it.
- **Tabs** are saved in `ui_state` (open scripts, order, active tab, preview tab) and restored on launch. Each tab opens its own session on first run and closes it with the tab.
- **Formatting:** `sql-formatter` (PostgreSQL and SQLite languages).
- **Export:** CSV, JSON (array of row objects) and SQL INSERT are written to a file chosen in a save dialog. Exporting runs the statement again and streams every row to the file, so large results never sit in memory; only read statements can be exported. Copy as TSV copies the loaded rows.

## Data model (new migration)

```
scripts
  path            text  primary key  -- relative to the scripts folder, "/" separators
  connection_id   uuid  null, references connections(id) on delete set null
  schema          text  null         -- PostgreSQL search_path for the tab's session
  params          text  null         -- JSON: last value per placeholder
  updated_at
```

## Steps

1. **Statement splitter and placeholders (TypeScript)**
   - Tokenizer, statement ranges, statement at cursor or selection, placeholder scan and rewrite to engine syntax.
   - vitest: strings, `E''` escapes, quoted identifiers, nested comments, dollar quotes with tags, trailing statements without `;`, each placeholder style.

2. **Statement classifier**
   - `dbrief-core::classify` with `sqlparser`, per dialect, as decided above.
   - cargo tests with a table of statements and expected labels.

3. **Query execution**
   - `dbrief-core::query`: run one statement on a session with parameters; return columns and the first page, or rows affected; duration; errors with code, message, detail, hint and position.
   - Block statements above the session's access level using the classifier.
   - Open result streams with Load more; close on the next statement.
   - Cancel and query timeout per engine.
   - Server notices captured per session (sqlx logs PostgreSQL notices through `log`; find a way to attribute them to the session, or read them on the connection directly).
   - cargo tests: SQLite always; PostgreSQL through testcontainers (types, paging, cancel, timeout, RO blocking, notices).

4. **Transactions**
   - Session transaction state from auto/manual mode and from user-typed `BEGIN` / `COMMIT` / `ROLLBACK`.
   - Commit and Roll back commands; the list of statements and rows affected in the open transaction, for confirm before commit.
   - Lost transaction reported to the tab (built on the reconnect logic from milestone 2).
   - cargo tests for each mode and for the lost-transaction path.

5. **Scripts folder**
   - `dbrief-core::scripts`: tree listing, read, atomic write, create, rename, move, delete to trash, watcher events.
   - Script metadata repository on the new table; carried along on rename and move.
   - cargo tests on a temp folder, including watcher events.

6. **Tauri commands and events**
   - Commands for scripts, sessions per tab, run, load more, cancel, commit, roll back, export.
   - Events for file changes, log entries and running state. Typed with `tauri-specta`.

7. **Tabs**
   - Tab strip in the editor area: script tabs, preview tab, dirty and running marks, close with prompts for uncommitted work.
   - Saved in `ui_state` and restored on launch.

8. **Scripts side panel**
   - Tree with folders, filter, new script and folder, rename, delete, drag to move.
   - Single click opens a preview tab, double click pins it.

9. **Editor**
   - CodeMirror 6 setup themed with the app tokens; line numbers; statement under the cursor marked.
   - Autosave, external change reload or conflict dialog.
   - Autocomplete: keywords and functions per dialect, table aliases in the current query.
   - Format and format on save.

10. **Toolbar**
    - Run, Run all, Explain (disabled), Stop; connection picker with access badge; schema picker (PostgreSQL); transaction mode; Format; Commit and Roll back while a transaction is open.

11. **Inline results**
    - Result block per statement: header (Result n, rows, duration), read-only grid, Load more, copy and export, pop out to the bottom panel or a tab.
    - Error block with code, message and position; running block with elapsed time and Cancel.
    - Setting to send results to the bottom panel's Results tab instead.

12. **Parameters**
    - Prompt listing the statement's placeholders, prefilled with remembered values, saved per script.

13. **Log tab**
    - Entries per session and tab: notices, statements, transaction events, errors, background SQL. Filter by kind; clear.

14. **Export**
    - Save dialog (needs the dialog save permission); CSV, JSON and SQL INSERT writers in Rust; TSV to the clipboard.
    - cargo tests for CSV quoting, JSON values and INSERT literal quoting per dialect.

15. **Settings**
    - Editor: show results inline, inline result row limit, autocomplete, format on save. Data grid: page size.

16. **Verify**
    - Run through the "Done when" list.
    - Update `2-roadmap.md`: milestone 3 done, milestone 4 next.

## Testing

- PostgreSQL tests use testcontainers as in milestone 2 and are skipped without Docker.
- The frontend logic that can be tested without a browser (splitter, placeholders, tab state, export formatting helpers) gets vitest coverage.

## Open questions

- None.
