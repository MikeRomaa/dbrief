# 7. Milestone 5: Grid Editing

Roadmap: milestone 5 of 9 (`2-roadmap.md`). Builds on milestone 4 (`6-explorer.md`).

## Goal

Users edit table data in the grid. Edits, inserts and deletes are staged and marked per row. Each data type has its own editor. Staged changes are reviewed as SQL, then committed in one transaction, or applied inside the tab's open transaction in manual mode. Paste, fill down and setting many cells at once speed up bulk edits. The inspector edits long text, JSON, arrays and binary values. Script results switch to the same grid component.

## Done when

- [ ] Tables with a primary key, a usable unique index, or (SQLite) a rowid are editable. Other tables, views and RO connections are read-only, and the toolbar says why.
- [ ] Cells edit in place with an editor for their type: text, number (validated), boolean (true / false / NULL), date (date picker), datetime (date picker and time), JSON (validated). Generated and identity-always columns can't be edited.
- [ ] Any nullable cell can be set to NULL. Inserted rows show column defaults. NULL and DEFAULT look different from real values and from each other.
- [ ] Rows can be added, duplicated and deleted. Updated, inserted and deleted rows are marked in the row gutter, and edited cells are marked too.
- [ ] Staged changes can be undone (⌘Z), reverted per cell or row, or reverted all at once.
- [ ] The staged changes bar shows counts, Review SQL, Revert all and Commit (⌘S). In manual mode the button reads Apply.
- [ ] Auto mode: Commit runs every staged change in one transaction. Any failure rolls everything back, the changes stay staged, and the failing row is shown. Confirm before commit lists the statements and rows affected first.
- [ ] Manual mode: Apply runs the changes inside the tab's transaction under a savepoint. A failure undoes only that batch, and the changes stay staged. The toolbar then shows the open transaction with Commit and Roll back.
- [ ] The grid toolbar has the transaction mode control, starting from the connection's setting.
- [ ] An UPDATE or DELETE that matches no row fails the commit ("row was changed or deleted").
- [ ] ⌘V pastes a TSV block as staged edits. Rows pasted past the end become inserted rows. ⌘D fills down. ⌘⏎ in an editor sets every selected cell to its value.
- [ ] The inspector edits the full value: long text, JSON (JSON / Tree / Raw, validate, format, revert cell), arrays as a list, binary (upload from file, download, set NULL). The Row tab edits fields too.
- [ ] Changing page, filter or sort, reloading, closing the tab or disconnecting with staged changes asks first.
- [ ] The bottom panel's Staged changes tab lists the active tab's changes and their SQL. The status bar shows the staged count.
- [ ] Settings → Data grid: date format. Date and datetime cells follow it.
- [ ] Inline and popped-out script results use the data grid component: column resize, range copy and the inspector (read-only).
- [ ] `cargo test`, `npm test` and `npm run lint` pass.

## Out of scope

- Editing views, including PostgreSQL's automatically updatable views
- Pickers for enum values and foreign key lookups (enums edit as text, and the database checks them)
- Editing script results
- Keeping staged changes across pages. Paging with staged changes asks first.
- Restoring staged edits on relaunch (future work in the spec)
- History entries tagged "Grid commit" (milestone 6). Grid statements are logged with their source so milestone 6 can tag them.
- Two editor groups (later)

## Design decisions

- **Row identity.** A new `table_edit_info` command runs on the background session when the Data view first loads, and again on Refresh. It is loaded live, not from the cache, so it reflects the table at that moment. It picks the first of:
  1. The primary key.
  2. A unique index that is not partial, has no expressions, and covers only `NOT NULL` columns. Several qualify? Pick the one with the fewest columns, then by name. PostgreSQL: `indisunique AND indpred IS NULL AND indexprs IS NULL`. SQLite: `pragma_index_list` unique with `partial = 0`, and no expression columns in `pragma_index_xinfo` (`cid = -2`).
  3. **SQLite rowid**, for rowid tables (not `WITHOUT ROWID`, not virtual). The page query selects it under the first of `rowid`, `_rowid_` and `oid` that isn't a column name. If all three are, the table is read-only. The session removes this column from the page and keeps it as the row's key, so column indexes for the grid, copy, find and the inspector don't change.

  Otherwise the table is read-only, with a reason: a view, an RO connection, or "no primary key or unique index". The reason shows in the toolbar.
- **Column facts for editing.** `table_edit_info` also returns each column's declared type (`format_type` on PostgreSQL, the declared type on SQLite), nullability, default expression, and whether it can be written. Generated columns (PostgreSQL `attgenerated`, SQLite `hidden` 2 / 3) and `GENERATED ALWAYS AS IDENTITY` columns can't be written. `BY DEFAULT` identity columns can. Editors are chosen from the declared type, not from the result's wire type name. That way domains, `varchar(n)`, `timestamp with time zone` and arrays are all known.
- **Staged changes live in the frontend** (`src/lib/grid/staging.ts`, pure and immutable, with vitest coverage). There are three kinds:
  - update: page row → changed columns
  - insert: a new row id → values
  - delete: page row

  A value is `null`, `default`, `text`, or `file` (a token for an uploaded binary value, see below). Rules:
  - Editing a cell back to its original value drops that edit.
  - Deleting an inserted row removes it.
  - Deleting an updated row keeps its edits, so reverting the delete brings them back.
  - ⌘Z steps back through earlier staging states, held as a simple stack.

  Original values never travel back from the frontend. Changes point at page rows, and Rust reads keys and originals from the page the session keeps.
- **SQL is built in Rust** (`dbrief-core::edit`). It makes one statement per row, in a fixed order: deletes, then updates, then inserts. That way a delete and an insert of the same key work.
  - **UPDATE** sets only the changed columns. **INSERT** lists only columns given a value; a row with none uses `DEFAULT VALUES`. Rows are matched by the identity columns. Identifiers are quoted for the dialect, as in `grid`.
  - **PostgreSQL literals:** text is `'…'` with quotes doubled. Text with backslashes is written as `E'…'` with the backslashes doubled, so it works whatever `standard_conforming_strings` is set to. Binary values become `decode('…', 'hex')`. Every other type is a text literal, and PostgreSQL converts it from the column's type.
  - **SQLite literals:** text is `'…'`, BLOBs are `X'…'`, and numbers are written unquoted for INTEGER and REAL affinity once Rust checks they parse. Key values must match by storage class, so SQLite page values now keep it: integers and reals become a new `Value::Number`, so keys are written back as numbers. Columns without affinity would not match a quoted literal.
  - Review SQL and the Staged changes tab show exactly the statements that will run (`preview_changes`).
- **Applying** (`Session::apply_changes`). Every statement goes through `Session::run`, so the access level check, transaction tracking and the Log all apply. Each UPDATE, DELETE and INSERT must affect exactly one row. Any other count fails the batch with "Row 12 was changed or deleted since it was loaded" (or the database error), and the result names the failing change so the grid can point at its row.
  - **Auto mode:** runs `BEGIN`, the statements, then `COMMIT`. A failure runs `ROLLBACK`. With **confirm before commit**, the statements run first. The transaction then stays open while a dialog shows each statement and its rows affected, and `finish_changes(commit)` commits or rolls back. The dialog in `ScriptTab` moves to `src/components/ui/CommitDialog.tsx` so both tab kinds use it.
  - **Manual mode:** `BEGIN` if no transaction is open (as `begin_if_needed` does), then `SAVEPOINT dbrief_grid`, the statements, and `RELEASE SAVEPOINT dbrief_grid`. A failure runs `ROLLBACK TO SAVEPOINT dbrief_grid` and then the release. This keeps earlier work in the transaction and recovers PostgreSQL's aborted state. The transaction stays open, and Commit / Roll back in the toolbar end it, with confirm before commit as in script tabs. ⌘S applies staged changes when there are any, and otherwise commits the open transaction.
  - After success the staged changes clear and the page reloads. In manual mode the reload runs inside the open transaction, so it shows the applied rows. Inserted rows show up wherever the sort puts them. The count reruns too.
  - A commit or rollback of a transaction that ran DDL still refreshes the schema, as before. Grid batches never run DDL.
- **Transaction mode in the grid toolbar.** It works like script tabs: per tab, starting from the connection's manual-transactions setting, and it can't change while a transaction is open. The table tab now reports `inTransaction` and a new `staged` count through `TabRuntime`. The close prompt adds "Discard staged changes" to Commit / Roll back / Cancel. Disconnecting asks the same way.
- **Staged changes and navigation.** Staged changes belong to the loaded page. Changing page, filter or sort, or reloading, asks: Commit (or Apply) / Discard / Cancel.
- **Display.**
  - The row gutter shows a glyph and tint per row: `+` inserted, `~` updated, `−` deleted (struck through). Edited cells are tinted.
  - Inserted rows go at the bottom of the page, numbered `+1`, `+2`, ….
  - NULL keeps its setting-based look. DEFAULT shows as `DEFAULT` in muted italics, with the default expression in its tooltip.
  - Marks never rely on color alone. The glyphs carry them, and cells get `aria-description` ("edited", "will be deleted").
  - Read-only columns and tables set `aria-readonly`.
  - New colors are added as tokens in `tokens.css` for both themes, checked for AA contrast.
- **Editing in the grid.**
  - Enter or F2 opens the editor, and typing a character opens it with that character. Enter saves and moves down, Tab saves and moves right, Escape cancels.
  - ⌘⏎ saves the value into every selected cell (set many).
  - Delete sets the selected cells to NULL. Non-nullable cells are skipped, with a message.
  - ⌘D fills down: the top cell of the selection goes into the cells below it in each column.
  - ⌘⇧N adds a row, and ⌘⌫ deletes the selected rows. The context menu also has Duplicate row, Set to NULL, Set to DEFAULT and Revert.
  - The new shortcuts go in the command registry, so milestone 9's keybinding editor can rebind them.
- **Editors** (`src/lib/grid/editors.ts` picks the kind from the declared type and engine, with vitest coverage):
  - **Text:** a text area over the cell that grows with line breaks (up to 12 lines, then scrolls). Enter saves; Shift-Enter or Option-Enter adds a line break. Pasted text keeps its line breaks. A value that is cut short (over 1,000 characters) is fetched in full before the editor opens, so it never edits a cut-short copy. JSON in a text column edits here too; the inspector also offers the JSON editor for it.
  - **Number:** an input that accepts integers for `int2` / `int4` / `int8` (checked against their range with BigInt), and decimals with an optional exponent for floats and `numeric`. `NaN` and `Infinity` are allowed where PostgreSQL allows them. SQLite INTEGER, REAL and NUMERIC affinity map here.
  - **Boolean:** a toggle that cycles true → false → NULL (NULL only when nullable). Space toggles it. SQLite `BOOL…` declared types map here and store `1` / `0`.
  - **Date / Datetime:** a date picker popover (`src/components/ui/DatePicker.tsx`, our own small calendar following the ARIA date picker dialog pattern, no new dependency). Datetime adds a time field (`HH:MM[:SS[.ffffff]]`). `timestamptz` keeps its UTC offset, shown and editable. SQLite columns map here only when the declared type mentions DATE or TIME and the value parses. Otherwise they edit as text.
  - **JSON:** an inline input that checks the JSON is valid. Big values open in the inspector.
  - **Arrays** and **binary** edit in the inspector. Enums, ranges, intervals, UUIDs and anything unknown edit as text, and the database validates them.
- **Dates.** PostgreSQL table tab sessions run `SET DateStyle TO ISO, YMD` after connecting, so dates arrive in a form `src/lib/grid/dates.ts` can parse. That covers offsets like `+05:30`, fractions, `BC`, and `infinity`. The Data grid **date format** setting is either ISO (`2026-11-07 14:03:05`, the default) or Locale (the OS format, through `Intl.DateTimeFormat`). It changes only the display. Edits are always written back as ISO text. Values that don't parse show as they are.
- **Clipboard.**
  - ⌘V reads TSV the way spreadsheets write it: quoted fields with tabs, line breaks and `""` inside (`src/lib/grid/tsv.ts`). The block is pasted at the active cell. A single value with a larger selection fills the whole selection.
  - Rows past the end of the page become inserted rows. Columns that can't be written are skipped, with a notice.
  - Every value is validated by its column's editor first. If any value fails, nothing is pasted, and the message names the first bad cell.
  - Pasted text is always text: an empty field is an empty string, not NULL.
- **Inspector editing.** The Cell tab becomes an editor for the active cell, staging its change on Save (⌘⏎):
  - Wrapped monospace text for text values.
  - JSON with JSON, Tree and Raw views, validation, Format and Revert cell. Tree is read-only and the other two edit.
  - Arrays as a list: add, remove and reorder items. The list is written back as an array literal by a new `serializePgArray` next to `parsePgArray`, with quoting and NULL items.
  - Binary: Upload from file, Download (the existing Save to file) and Set NULL. Rust reads an uploaded file into the session's store of uploads and returns a token, the size and an image check, so the cell can show `<PNG image 14 kB>` before commit. Uploads are kept until the batch commits or is discarded. Files over 64 MB are refused.

  The Row tab lists every column with the inline editors, which helps with wide tables. For read-only tables both tabs stay as they are today.
- **Bottom panel and status bar.** The Staged changes tab, a placeholder until now, lists the active table tab's changes grouped by row, each with its SQL and a Revert button. Review SQL opens it. The status bar shows "3 staged" for the active tab and opens the tab when clicked.
- **Script results on the data grid.**
  - `DataGrid` gets an optional sort (results have no ORDER BY to rewrite) and an in-memory layout (not saved per table).
  - Load more appends rows. Inline results keep their height cap.
  - Script result rows become cells in TypeScript: text or null, with BLOBs as their hex preview text.
  - Copy for results goes through a new `copy_rows` command that takes the rows from the frontend and reuses `grid::copy`.
  - `InspectorTarget` gains a source: the session page for table tabs, or the in-memory value for results.
  - Results stay read-only.

## Data model

No migration. Staged changes and uploads live in memory only. `settings.toml` gains `data_grid.date_format` (`"iso"` | `"locale"`).

## Steps

1. **Row identity and column facts**
   - `table_edit_info` loader per engine, as decided above.
   - cargo tests (SQLite always, PostgreSQL through testcontainers):
     - a primary key, including composite keys
     - which unique indexes qualify (partial, expression and nullable ones don't)
     - rowid tables, `WITHOUT ROWID` tables, and a column named `rowid`
     - generated and identity columns
     - views
     - RO connections

2. **Page keys and values**
   - SQLite rowid as a hidden key column, kept beside the page.
   - `Value::Number` for SQLite integers and reals, carried through `Cell`, copy, find and export.
   - `DateStyle` for PostgreSQL table sessions.
   - cargo tests: the rowid stays out of the columns; numbers copy and export unchanged.

3. **SQL generation** (`dbrief-core::edit`)
   - Statements from a batch and the session's page; deletes, then updates, then inserts; `DEFAULT VALUES`.
   - cargo tests:
     - literal quoting: quotes, backslashes, Unicode, empty strings, NULL, DEFAULT
     - bytea and BLOBs
     - SQLite numbers and keys
     - composite and unique-index keys, rowid
     - odd identifiers
     - refusing to write columns that can't be written

4. **Applying changes**
   - `Session::apply_changes` for auto and manual modes, the savepoint, the one-row check, and the confirm step (`finish_changes`).
   - cargo tests on both engines:
     - success in each mode
     - a failure that rolls back the whole batch (auto)
     - a failure that keeps earlier work in the transaction (manual, including PostgreSQL's aborted state)
     - a row deleted by another session, which matches nothing and rolls back
     - access level blocking on RO
     - transaction state and statement tracking after each case

5. **Uploads and commands**
   - Session store of uploads: stage a file, drop it on commit or discard.
   - Tauri commands: `table_edit_info`, `preview_changes`, `apply_changes`, `finish_changes`, `stage_file`, `discard_uploads`, `copy_rows`. Bindings regenerated with `tauri-specta`.

6. **Staging model** (`src/lib/grid/staging.ts`)
   - Updates, inserts and deletes, the rules above, undo, counts, and the batch sent to the backend.
   - vitest for every rule.

7. **Value helpers**
   - `editors.ts` (editor kind per declared type and engine, number validation), `dates.ts` (parse and format), `tsv.ts` (parse), `serializePgArray`.
   - vitest for each, including round trips with `parsePgArray` and with the TSV that `copy` writes.

8. **Grid editing**
   - In-cell editors, the date picker, row gutter marks, NULL and DEFAULT looks, and the editing keys and context menu entries.
   - Shortcuts registered as commands.
   - ARIA: `aria-readonly`, `aria-invalid`, `aria-description` for marks, and live announcements for staging actions ("3 cells set to NULL").

9. **Table tab**
   - First split `TableTab.tsx` (already 718 lines): data loading and paging into `useTablePage`, staging into `useStaging`, and the toolbar into its own component.
   - Then add:
     - the transaction mode control, "Transaction open" with Commit and Roll back, and the read-only reason
     - the staged changes bar, the commit and apply flows, the confirm dialog, and errors pointing at the failing row
     - navigation prompts, the close and disconnect prompts (`TabRuntime.staged`)

10. **Bottom panel and status bar**
    - The Staged changes tab with SQL preview and per-change revert, and Review SQL opening it.
    - The status bar staged count.

11. **Inspector editing**
    - Cell tab editors for text, JSON (three views), arrays and binary (upload, download, set NULL).
    - Row tab field editing.

12. **Clipboard and bulk edits**
    - Paste with validation and inserted rows, fill down, and set many.

13. **Script results on the data grid**
    - `ResultBlock` and the popped-out result render `DataGrid`, with load more and the inspector source.
    - Copy through `copy_rows`.
    - Remove the old simple table.

14. **Settings**
    - Data grid: date format, used by the grid's date and datetime cells.

15. **Verify**
    - Run through the "Done when" list in both themes, on PostgreSQL and SQLite, with:
      - a composite-key table
      - a unique-index-only table
      - a rowid-only SQLite table
      - a wide table
      - a table with every editor type
    - Check keyboard-only editing from start to commit, and a screen reader pass over marks and editors.
    - Update `1-specification.md` where decisions changed it, and `2-roadmap.md`: milestone 5 done.

## Testing

- PostgreSQL tests use testcontainers as before and are skipped without Docker.
- Rust covers identity, SQL generation and applying, including failure paths, on both engines.
- vitest covers the staging model, editor kinds and validation, date parsing and formatting, TSV parsing, array serialization, and paste planning (which cells and rows a block lands in).

## Open questions

- None.
