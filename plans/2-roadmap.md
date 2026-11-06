# 2. Roadmap

The build is split into milestones. Each one leaves the app runnable with something new to use.

Only the **next** milestone gets a detailed plan (`plans/3-…`, `plans/4-…`, …), written just before building it. This roadmap and the spec (`1-specification.md`) are updated as we go.

## Milestones

| #   | Milestone                  | Done when                                                                                                                      | Spec sections                                                                   |
| --- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------- |
| 1   | Foundation                 | Tauri app opens with the shell layout, light/dark themes, app SQLite database and `settings.toml`                              | Platform, Data storage, App shell, Accessibility basics                         |
| 2   | Connections + first launch | Add, save and connect to PostgreSQL and SQLite. Welcome screen on first launch                                                 | First launch, Access levels and transactions, 1. Connections, 2. Add connection |
| 3   | Script editor              | Write SQL, run it and see inline results, with paging, parameters, formatting and the Log tab                                  | 4. Script, Export, Log                                                          |
| 4   | Explorer + table browse    | Schema cache, Explorer tree, ⌘P search, read-only data grid, export                                                            | Search, 3. Table (Explorer, Table tab, read-only grid)                          |
| 5   | Grid editing               | Staged edits, type-aware editors, commit, clipboard, large values                                                              | 3. Table (Data grid editing)                                                    |
| 6   | History                    | History panel, filters and preview tabs                                                                                        | 6. History                                                                      |
| 7   | Diagrams                   | Diagram canvas, table selection, layout saving, export                                                                         | 7. Diagram                                                                      |
| 8   | Explain                    | Plan view for PostgreSQL, simplified tree for SQLite                                                                           | 5. Explain analyze                                                              |
| 9   | Ship polish                | Connection export/import, SQLite file opening, auto-updater, full accessibility pass, packaging for macOS/Windows/Linux        | Updates, Accessibility, Settings (remaining)                                    |

## Order notes

- Milestones 1–5 are the core and run in order.
- 6, 7 and 8 are independent of each other and can be reordered.
- The first-launch screen is in milestone 2 because it sets the scripts folder setting, which milestone 3 then uses. Its optional connection import arrives with export/import in milestone 9.
- Connection export and import (TOML, no secrets) moved from milestone 2 to milestone 9, to get the table view and SQL console in sooner.
- Opening SQLite files by drag-drop and "Open with" (file associations, single instance) moved from milestone 2 to milestone 9 with packaging. The backend part (`open_sqlite_file`) was built in milestone 2.
- The statement classifier (read / write / DDL per access level) moved from milestone 2 to milestone 3, where running SQL first needs it. Idea so far: `sqlparser` with the PostgreSQL and SQLite dialects; unparseable SQL counts as DDL.
- The active connection in the status bar (name, access level, server version) and the color tag tint of the top and status bars, with its Appearance setting ("Highlight production" in the mockup), moved from milestone 2 to milestone 4, where the table view first gives a clear active connection.
- The grid toolbar's transaction mode and the Data grid date format setting moved from milestone 4 to milestone 5. The grid only reads until editing arrives, and dates show as the database's text until the date editors exist.
- Milestone 5 also switches inline and popped-out script results to the data grid component from milestone 4, giving them column resize, range copy and the inspector.
- Settings sections are added in the milestone that introduces each feature; milestone 9 covers anything left.

## Status

| #   | Milestone                  | Plan                 | Status  |
| --- | -------------------------- | -------------------- | ------- |
| 1   | Foundation                 | `3-foundation.md`    | Built   |
| 2   | Connections + first launch | `4-connections.md`   | Built   |
| 3   | Script editor              | `5-script-editor.md` | Built   |
| 4   | Explorer + table browse    | `6-explorer.md`      | Built   |
| 5   | Grid editing               | not written          |         |
| 6   | History                    | not written          |         |
| 7   | Diagrams                   | not written          |         |
| 8   | Explain                    | not written          |         |
| 9   | Ship polish                | not written          |         |
