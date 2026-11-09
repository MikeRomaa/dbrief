# 6. Milestone 4: Explorer + Table Browse

Roadmap: milestone 4 of 9 (`2-roadmap.md`). Builds on milestone 3 (`5-script-editor.md`).

## Goal

Users browse a connection's schema in the Explorer, find any table or column with ⌘P, and open tables in tabs: a read-only data grid with filter, sort and paging, plus read-only structure views. A local schema cache powers the Explorer, search and autocomplete, and works offline. The status bar shows the active connection, tinted with its color tag. Grid editing follows in milestone 5.

## Done when

- [ ] Connecting a connection loads its schema into the local cache. The cache refreshes after DDL run in the app, and on demand.
- [ ] The Explorer shows the active connection's tree: PostgreSQL schemas → tables / views / functions / sequences; SQLite tables / views / indexes / triggers, with attached databases as extra top-level nodes. Tables show columns and types.
- [ ] The Explorer filters objects, shows estimated row counts and sizes, and gives an exact count on demand.
- [ ] Right-clicking a table offers open data, open structure, copy name, copy DDL and count rows.
- [ ] A single click opens a table in a preview tab; a double click pins it. Table tabs are restored on relaunch.
- [ ] Table tabs have Data, Columns, Indices, Constraints, Triggers and DDL sub-views, all read-only.
- [ ] The grid toolbar has a WHERE filter, ORDER BY, paging ("1–200 of 1,284") and export.
- [ ] Columns resize (double-click to fit), reorder by dragging, hide and show (remembered per table), sort when the header is clicked, and copy their name.
- [ ] Cell ranges are selected with mouse and keyboard and copied as TSV. Rows copy as INSERT statements or JSON from the context menu.
- [ ] Find (⌘F) searches the loaded rows.
- [ ] Long text is cut short in cells. Arrays show inline. Binary values show their size, and PNG or JPEG values show an image preview. The inspector shows the full value, a hex preview for binary, and saves binary values to a file.
- [ ] ⌘P finds connections, tables, columns and scripts, also for disconnected connections. Picking a table from a disconnected connection connects first (asking for credentials if needed), then opens it.
- [ ] Script autocomplete suggests schemas, tables and columns from the cache.
- [ ] The status bar shows the active connection's name, access level and server version. With the setting on, the top and status bars are tinted with its color tag.
- [ ] Settings → Appearance: tint bars with the connection color. Settings → Data grid: NULL display style, JSON truncation length.
- [ ] Background SQL (schema loading, counts, structure, DDL) shows in the Log tab under Background.
- [ ] `cargo test`, `npm test` and `npm run lint` pass.

## Out of scope

- Editing, staged changes, row identity checks, type-aware editors, paste, fill down, upload from file (milestone 5)
- The transaction mode control in the grid toolbar. The grid only reads in this milestone, so it arrives with editing in milestone 5.
- The date format setting. Values arrive as the database's text, so it comes with the date editors in milestone 5.
- "Add to a saved diagram" in the Explorer context menu (milestone 7)
- Switching inline and popped-out script results to the new grid component (milestone 5). They keep their simple table for now.
- Two editor groups and dragging tabs to split (later)
- Schema-level operations in the Explorer (create, drop, rename). Diagrams are view-only, and the "Edit table" modal is future work.

## Design decisions

- **Connected connections.** A connection counts as connected while it has a **background session**. This is one session per connection, in auto-commit mode, used only for SQL the app runs itself: loading the schema, structure views, DDL text and counts. Connecting from the Connections view, the Explorer or ⌘P opens it; today's standalone Connections-view session becomes this session. Disconnect closes every session of the connection. Tabs with an open transaction ask Commit / Roll back / Cancel first, as when closing a tab. Script and table tabs still open their own sessions (one per tab, as the spec requires), and opening one also connects the background session.
- **Active connection.** This is the active tab's connection. With no tab open, or a tab with no connection, it is the most recently connected one. The Explorer lists every connected connection as a top-level node over its schema tree and marks the active one; a disconnected connection doesn't appear. The status bar shows the active connection's name, access level and server version. When the Appearance setting is on, the top and status bars are tinted with its color tag (mockup: "Highlight production").
- **Schema cache.** The cache lives in the app database (new migration below). Each refresh replaces one connection's rows in a single transaction, so readers never see half a refresh. It holds what the Explorer, search and autocomplete need: objects with kind, parent table (for indexes and triggers), function signature, estimated rows and size, and table and view columns with type, nullability, default and primary key position. A connection with a large schema is loaded in a few bulk catalog queries, not one query per table.
  - **PostgreSQL:** reads `pg_namespace`, `pg_class`, `pg_attribute`, `pg_proc` and `pg_index` for the connected database. It skips `pg_catalog`, `information_schema`, `pg_toast` and temporary schemas. Estimated rows come from `reltuples`; −1 (never analyzed) shows no estimate. Size is `pg_total_relation_size`.
  - **SQLite:** runs `pragma database_list`, then reads `sqlite_schema` and `pragma_table_xinfo` for each database. The background session runs the connection's startup SQL, so databases attached there show up. Estimates come from `sqlite_stat1` when it exists. Sizes come from the `dbstat` virtual table, which we assume the bundled SQLite includes.
  - **Refresh triggers:** on connect; after a DDL statement (by the classifier) succeeds in auto-commit mode; after a commit or rollback of a transaction that ran DDL. Refreshing waits for the commit because the background session can't see another session's uncommitted DDL. The Explorer also has a Refresh button. Each refresh sends a `schema-changed` event.
  - Removing a connection deletes its cache through a foreign key cascade.
- **Structure views are live, not cached.** Columns, Indices, Constraints, Triggers and DDL load on the background session when the sub-view first opens, and again on Refresh.
  - **PostgreSQL** has no `SHOW CREATE TABLE`, so the DDL is put together in Rust from the catalogs: columns with types, defaults and `NOT NULL`, then `pg_get_constraintdef`, `pg_get_indexdef` and `pg_get_triggerdef`. Views use `pg_get_viewdef`, functions `pg_get_functiondef`, and sequences are built from `pg_sequence`.
  - **SQLite** DDL is the `sql` text from `sqlite_schema` for the table, its indexes and its triggers.
  - "Copy DDL" uses the same code.
- **Table tabs.** A table tab's key is `/table/<connection>/<kind>/<schema>/<name>` (schema and name URI-encoded). Script paths are relative and never start with `/`, so script renames and deletes never touch table tabs, and the saved tab format is unchanged. All tabs share the one preview slot. A table tab opens its own session the first time the Data view loads. If the connection isn't connected, it connects first, asking for credentials when needed. The tab title is the table name; its tooltip gives the connection and schema. A table that a refresh no longer finds shows "This table no longer exists" in its tab.
- **Grid query, built in Rust.** The query is `SELECT * FROM <schema>.<table> [WHERE …] [ORDER BY …] LIMIT n OFFSET m`, with identifiers quoted for the dialect. The WHERE and ORDER BY text is the user's own, so the whole statement must parse as **exactly one `SELECT`** before it is sent. Without that check, `1=1; DROP …` would run two statements over the simple query protocol. It runs on the tab's session through the existing `Session::run`, reading one page and then closing the result.
  - **Stable pages:** with no ORDER BY, rows are ordered by the primary key (SQLite: `rowid` for rowid tables). PostgreSQL tables and views without a primary key get no order, and the toolbar says that pages may shift.
  - **Header sort:** clicking a header cycles ascending → descending → none and writes the result into the ORDER BY field. Shift-click adds a secondary sort.
  - **Paging:** first, previous, next and last page, with page size from Settings → Data grid. Pages use `LIMIT`/`OFFSET`, so deep pages on huge tables are slow; that's acceptable for browsing.
  - **Total count:** an exact `count(*)` with the current filter runs on the background session after the page loads. A count for an older filter is ignored when it arrives. An unfiltered table whose estimate is 1,000,000 rows or more skips the count and shows "of ~1.2M" with a Count button. The Explorer's exact count uses the same code.
- **Grid cells.** The grid needs more than the text-or-null rows that script results use, so the table page turns each value into a display cell in Rust: `Null`, `Text { text, full_length }` cut at 1,000 characters, or `Binary { size, image: png | jpeg | none }`. PostgreSQL `bytea` arrives as `\x…` hex text over the simple protocol and is decoded; images are recognized by their magic bytes. The session keeps the **full values of the current page** in memory, so the inspector, copy, "Save to file" and Find work on whole values without sending large values over IPC for every page.
- **Arrays and JSON.** PostgreSQL arrays show inline in their text form (`{a,b}`). The inspector parses the array literal and shows it as a read-only list. JSON shows compact in the cell, cut at the JSON truncation length setting, and pretty-printed in the inspector.
- **Grid component** (`src/components/grid/`). Rows and columns are virtualized by hand (fixed row height, no new dependency), so wide tables and large pages stay fast. It uses ARIA `role="grid"` with one active cell (`aria-activedescendant`).
  - **Keyboard:** arrows, Home/End, PgUp/PgDn and ⌘↑/↓ move the active cell. Shift extends the range and ⌘A selects all. Mouse drag selects too.
  - **Column widths** come from the header and a sample of values the first time a table opens. Columns resize by dragging and fit to their content on double-click. They reorder by dragging, or with "Move left/right" in the header menu for keyboard users. They hide and show from the header menu and a Columns menu in the toolbar.
  - **Layout** (widths, order, hidden columns) is saved per table in the app database (`table_layouts`, cascading with the connection).
  - **NULL** uses the NULL display style setting and the `--text-muted` look, so it never looks like a real value.
- **Copying.** ⌘C copies the selected range as TSV, and "Copy with headers" adds the header line. "Copy as INSERT" and "Copy as JSON" copy the selected rows, and "Copy column name" copies the header. Copying is done in Rust from the full page values, reusing the writers in `export.rs`, so cut-short cells copy in full.
- **Find (⌘F).** A find bar over the grid searches the full values of the loaded page in Rust. It highlights matches and steps through them with Enter / Shift-Enter. The bar says that it searches the loaded page only and points to the WHERE filter.
- **Inspector.** The inspector has two tabs.
  - **Cell** shows the selected cell's full value: wrapped monospace text, pretty-printed JSON, arrays as a list, or for binary values a hex preview of the first 4 kB, an image preview for PNG or JPEG, and "Save to file". Values over a few MB load only on request.
  - **Row** lists every column of the selected row.
  - Editing arrives in milestone 5.
- **Export** from the grid toolbar reruns the grid query with the current filter and order, without LIMIT and OFFSET, through the existing streaming export. "Copy page as TSV" copies the loaded page.
- **Search (⌘P)** has a Rust command over the connections and the schema cache, and the frontend searches scripts from the script tree it already has.
  - **Ranking:** results are grouped as Connections, Tables, Columns and Scripts, so each group is ranked on its own. Matching is case-insensitive and fuzzy (subsequence), scoring prefix and word-boundary matches higher. A dotted query matches `schema.table` and `table.column`.
  - **Picking a result:** a connection connects and shows it in the Explorer. A table opens a table tab, and a column opens its table and scrolls to the column. Both connect first if needed, through the existing connect flow with its credential prompts. A script opens its tab.
- **Autocomplete** adds a CodeMirror completion source fed from the cache for the tab's connection: schemas, tables (qualified as needed for the `search_path`), and columns after `table.` or `alias.`. The latter builds on milestone 3's alias detection. It updates when `schema-changed` fires.

## Data model (new migration)

```
schema_objects
  id              integer  primary key
  connection_id   uuid     references connections(id) on delete cascade
  schema          text               -- PostgreSQL schema, or SQLite database name ("main", attached name)
  name            text
  kind            text               -- table | view | materialized-view | function | sequence | index | trigger
  parent          text  null         -- table of an index or trigger
  detail          text  null         -- function arguments and return type
  estimated_rows  integer null
  size_bytes      integer null
  index (connection_id, schema, name)

schema_columns
  connection_id   uuid     references connections(id) on delete cascade
  schema          text
  table_name      text
  ordinal         integer
  name            text
  type_name       text
  nullable        boolean
  default_value   text  null
  pk_ordinal      integer null
  primary key (connection_id, schema, table_name, ordinal)

table_layouts
  connection_id   uuid     references connections(id) on delete cascade
  schema          text
  table_name      text
  layout          text               -- JSON: column order, widths, hidden columns
  primary key (connection_id, schema, table_name)

connections
  + schema_refreshed_at  text null
```

## Steps

1. **Schema introspection**
   - `dbrief-core::schema`: catalog queries per engine returning objects and columns, as decided above.
   - Cache repository: replace a connection's cache in one transaction, read the tree, read columns for a table, search.
   - cargo tests: SQLite always (attached databases, `sqlite_stat1` present and absent, `WITHOUT ROWID` tables); PostgreSQL through testcontainers (schemas, views, materialized views, overloaded functions, sequences, partitioned tables, never-analyzed tables).

2. **Background sessions and refresh**
   - One background session per connection in `SessionManager`; connect, disconnect and "connected" state built on it.
   - Refresh on connect, after DDL in auto-commit, and after commit or rollback of a transaction that ran DDL; `schema-changed` event.
   - Background SQL reported to the Log.
   - cargo tests for each refresh trigger and for disconnect closing all of a connection's sessions.

3. **Structure and DDL**
   - Loaders for columns, indexes, constraints and triggers; DDL text per object kind and engine.
   - cargo tests comparing generated PostgreSQL DDL to the objects it was made from (create, generate, drop, recreate from the DDL).

4. **Table page**
   - `dbrief-core::grid`: query builder with dialect quoting, the single-`SELECT` check, default order, paging, count (and the 1M estimate cutoff).
   - Display cells (truncation, bytea decoding, image detection) and the page's full values kept on the session; read a full value, save a value to a file, find in the page, copy a range as TSV / INSERT / JSON.
   - cargo tests: quoting of odd identifiers, rejecting `1=1; DROP …` and similar, default order per table kind, cell conversion, find, and copy formats.

5. **Tauri commands and events**
   - Commands for connect and disconnect (background session), schema tree, refresh, structure, DDL, table page, count, cell value, save cell, find, copy, search, table layouts.
   - `schema-changed` event. Bindings regenerated with `tauri-specta`.

6. **Tabs**
   - Table tab keys (`src/lib/tabs/tableTabs.ts`); vitest for the keys and for script renames and deletes leaving table tabs alone.
   - The workspace renders both tab kinds; closing a table tab closes its session.

7. **Active connection**
   - Active connection from the active tab or the last connect; status bar name, access level and server version.
   - Color tag tint of the top and status bars, with the Appearance setting.

8. **Explorer panel**
   - Open connections as top-level nodes, filter, Refresh; flattened, virtualized tree with roving focus and ARIA tree roles.
   - Node kinds per engine; row counts and sizes; exact count on demand.
   - Context menu: open data, open structure, copy name, copy DDL, count rows. Single click opens a preview tab, double click pins it.

9. **Table tab**
   - Sub-view switcher: Data, Columns, Indices, Constraints, Triggers, DDL. Structure views are read-only tables; the DDL view is preformatted text with a copy button.

10. **Data grid**
    - Virtualized grid, keyboard and mouse selection, column resize, fit, reorder, hide and show, saved layout.
    - Header menu and cell context menu; copy actions; NULL style; numeric alignment (reusing `isNumeric`).

11. **Grid toolbar**
    - WHERE and ORDER BY fields (plain monospace inputs), Apply on Enter, Escape clears the filter.
    - Paging and count; Columns menu; export and copy page as TSV; Refresh.
    - Find bar (⌘F).

12. **Inspector**
    - Cell and Row tabs for the grid selection: text, JSON, array list, hex preview, image preview, Save to file.

13. **Search**
    - Rust search command; scripts matched in the frontend with the same scoring (vitest for the scoring).
    - Popover results grouped by kind, keyboard navigation, open actions with connect-first.

14. **Autocomplete**
    - Completion source from the cache for schemas, tables and columns; refreshed on `schema-changed`.

15. **Settings**
    - Appearance: tint bars with the connection color. Data grid: NULL display style, JSON truncation length.

16. **Verify**
    - Run through the "Done when" list, in both themes, with a large PostgreSQL schema (thousands of tables) and a wide table (100+ columns).
    - Update `2-roadmap.md`: milestone 4 done, milestone 5 next.

## Testing

- PostgreSQL tests use testcontainers as before and are skipped without Docker.
- The frontend logic that can be tested without a browser gets vitest coverage: table tab keys, search scoring, number formats, grid selection ranges, column layout changes, header sorting, cell text, the Explorer tree and PostgreSQL array literal parsing.

## Open questions

- None.
