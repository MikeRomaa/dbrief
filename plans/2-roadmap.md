# 2. Roadmap

The build is split into milestones. Each one leaves the app runnable with something new to use.

Only the **next** milestone gets a detailed plan (`plans/3-…`, `plans/4-…`, …), written just before building it. This roadmap and the spec (`1-specification.md`) are updated as we go.

## Milestones

| #   | Milestone                  | Done when                                                                                                                      | Spec sections                                                                   |
| --- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------- |
| 1   | Foundation                 | Tauri app opens with the shell layout, light/dark themes, app SQLite database and `settings.toml`                              | Platform, Data storage, App shell, Accessibility basics                         |
| 2   | Connections + first launch | Add, save and connect to PostgreSQL and SQLite. Welcome screen on first launch. SQLite files open by drag-drop and "Open with" | First launch, Access levels and transactions, 1. Connections, 2. Add connection |
| 3   | Script editor              | Write SQL, run it and see inline results, with paging, parameters, formatting and the Log tab                                  | 4. Script, Export, Log                                                          |
| 4   | Explorer + table browse    | Schema cache, Explorer tree, ⌘P search, read-only data grid, export                                                            | Search, 3. Table (Explorer, Table tab, read-only grid)                          |
| 5   | Grid editing               | Staged edits, type-aware editors, commit, clipboard, large values                                                              | 3. Table (Data grid editing)                                                    |
| 6   | History                    | History panel, filters and preview tabs                                                                                        | 6. History                                                                      |
| 7   | Diagrams                   | Diagram canvas, table selection, layout saving, export                                                                         | 7. Diagram                                                                      |
| 8   | Explain                    | Plan view for PostgreSQL, simplified tree for SQLite                                                                           | 5. Explain analyze                                                              |
| 9   | Ship polish                | Auto-updater, full accessibility pass, packaging for macOS/Windows/Linux                                                       | Updates, Accessibility, Settings (remaining)                                    |

## Order notes

- Milestones 1–5 are the core and run in order.
- 6, 7 and 8 are independent of each other and can be reordered.
- The first-launch screen is in milestone 2 because it needs connection import. It also sets the scripts folder setting, which milestone 3 then uses.
- File associations are in milestone 2 because opening a SQLite file creates a connection.
- Settings sections are added in the milestone that introduces each feature; milestone 9 covers anything left.

## Status

| #   | Milestone                  | Plan               | Status  |
| --- | -------------------------- | ------------------ | ------- |
| 1   | Foundation                 | `3-foundation.md`  | Built   |
| 2   | Connections + first launch | `4-connections.md` | Planned |
| 3   | Script editor              | not written        |         |
| 4   | Explorer + table browse    | not written        |         |
| 5   | Grid editing               | not written        |         |
| 6   | History                    | not written        |         |
| 7   | Diagrams                   | not written        |         |
| 8   | Explain                    | not written        |         |
| 9   | Ship polish                | not written        |         |
