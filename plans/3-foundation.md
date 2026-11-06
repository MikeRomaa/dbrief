# 3. Milestone 1: Foundation

Roadmap: milestone 1 of 9 (`2-roadmap.md`).

## Goal

A Tauri app that opens with the full shell layout (empty panels), light/dark themes, the app's SQLite database and `settings.toml`. Every later milestone builds on this.

## Done when

- [ ] `npm run tauri dev` opens the app on Windows (and builds on macOS/Linux without code changes).
- [ ] Shell shows all regions: top bar, activity rail, side panel, editor groups, bottom panel, inspector, status bar.
- [ ] Side panel resizes (200–420px); bottom panel collapses to 30px; inspector toggles.
- [ ] Theme switches between Light / Dark / System and follows the OS when set to System.
- [ ] App database is created in the app data directory, with migrations applied on launch.
- [ ] `settings.toml` is created with defaults, read on launch, and changes made in the app are written back.
- [ ] Layout (panel sizes, collapsed/visible state, active rail item) is restored on relaunch.
- [ ] Every shell control is reachable by keyboard and has an accessible label.
- [ ] `cargo test`, `npm test` and `npm run lint` pass.

## Out of scope

- Real tabs, editor groups splitting, preview tabs (milestone 3+ when there is content to open)
- Connections, scripts, search, any database drivers for user connections
- Settings view beyond the Appearance → Theme control
- Keybinding rebinding UI (milestone 9)

## Stack

| Area | Choice |
|---|---|
| App shell | Tauri 2 |
| Frontend | React 19 with React Compiler, TypeScript 7, Vite |
| Styling | Plain CSS + CSS modules on Contrast design tokens |
| Rust database layer | sqlx (SQLite now; PostgreSQL in milestone 2) |
| Package manager | npm |
| Lint / format | Biome (TS), rustfmt + clippy (Rust) |
| Tests | cargo test; Vitest for logic only |
| Version control | git, no CI yet |

Note on sqlx: the typed query macros (`query!`, `query_as!`) are used for the app's own tables. User queries in later milestones run through sqlx's dynamic row API, since their columns aren't known at build time.

## Repo layout

```
dbrief/
├── Cargo.toml              # Cargo workspace
├── crates/
│   └── dbrief-core/        # storage, migrations, settings; no Tauri dependency
│       ├── migrations/     # sqlx SQL migrations
│       └── src/
├── src-tauri/              # Tauri app crate: thin commands calling dbrief-core
├── src/                    # React frontend
│   ├── shell/              # layout regions
│   ├── theme/              # tokens.css, theme logic
│   ├── state/              # layout + settings state
│   └── lib/                # pure logic (tested with Vitest)
├── package.json
├── biome.json
└── plans/
```

## Steps

1. **Scaffold**
   - `git init`, `.gitignore` for Rust, Node and Tauri.
   - Create the Tauri 2 + React + TypeScript app with Vite and npm.
   - Turn on React Compiler (`babel-plugin-react-compiler`) and TypeScript 7.
   - Convert to a Cargo workspace with `crates/dbrief-core` and `src-tauri`.

2. **Tooling**
   - Biome config; `npm run lint` and `npm run format`.
   - rustfmt + clippy; `cargo clippy -- -D warnings`.
   - Vitest with one sample logic test; `npm test`.

3. **Design tokens and themes**
   - Pull the Contrast token values from the Claude Design project into `src/theme/tokens.css`, renamed to readable names. The mockups' short names are only used to look values up:

     | Token | Mockup name | Used for |
     |---|---|---|
     | `--color-bg` | `--bg` | Main background |
     | `--color-surface` | `--sf` | Panels, bars, toolbars |
     | `--color-raised` | `--rs` | Raised surfaces (cards, popovers) |
     | `--color-hover` | `--hv` | Hovered rows and items |
     | `--color-selected` | `--sel` | Selected rows and items |
     | `--color-border` | `--bd` | Default borders and dividers |
     | `--color-border-strong` | `--bx` | Emphasized borders (section headers) |
     | `--color-text` | `--fg` | Primary text |
     | `--color-text-muted` | `--mu` | Secondary text, labels |
     | `--color-text-faint` | `--fa` | Placeholders, line numbers |
     | `--color-changed`, `--color-changed-bg` | `--st`, `--stb` | Staged edits, focus, links |
     | `--color-added`, `--color-added-bg` | `--ad`, `--adb` | Inserted rows, success |
     | `--color-removed`, `--color-removed-bg` | `--rm`, `--rmb` | Deleted rows |
     | `--color-error`, `--color-error-bg` | `--er`, `--erb` | Errors |
     | `--color-warning`, `--color-warning-bg` | `--wn`, `--wnb` | Warnings |
     | `--syntax-keyword` | `--kw` | SQL keywords |
     | `--syntax-string` | `--str` | String literals |
     | `--syntax-number` | `--num` | Numeric literals |
     | `--syntax-comment` | `--cm` | Comments |
     | `--font-ui` | `--ui` | IBM Plex Sans |
     | `--font-mono` | `--mono` | Paper Mono |
   - Light and dark values on `[data-theme]`; System follows `prefers-color-scheme`.
   - Bundle the fonts locally (no network fetch at runtime).
   - Turn off transitions under `prefers-reduced-motion`.

4. **App database**
   - `dbrief-core::storage`: open (or create) `dbrief.db` in the Tauri app data directory with sqlx.
   - Embedded migrations (`sqlx::migrate!`) run on launch.
   - First migration: a `ui_state` key/value table for layout. Later milestones add their own tables.
   - cargo tests against a temp-directory database.

5. **Settings file**
   - `dbrief-core::settings`: typed `Settings` struct with serde and defaults. Start with `appearance.theme`.
   - File format is **TOML**. Settings are grouped into tables matching the Settings sections (e.g. `[appearance]`, `[editor]`, `[data_grid]`).
   - Create `settings.toml` with defaults if missing, with a short comment above each setting describing it.
   - Writes from the app edit the file in place and **keep the user's comments, key order and formatting**, using the `toml_edit` crate rather than re-serializing the whole file.
   - Unknown keys are kept, not dropped.
   - Invalid TOML: keep the file, use defaults, and show a warning in the status bar.
   - cargo tests for defaults, round-trip with comments preserved, and invalid files.

6. **Tauri commands and typed bindings**
   - Commands: `get_settings`, `update_settings`, `get_ui_state`, `set_ui_state`.
   - Generate TypeScript types from Rust with `tauri-specta` so the frontend calls are typed.

7. **Shell layout**
   - Regions and sizes from the spec: top bar 36px, rail 44px, side panel 248px (200–420), editor area (flex, min 320px), bottom panel 220px (collapses to 30px), inspector 300px (optional), status bar 24px.
   - Drag handles to resize the side panel and bottom panel.
   - Top bar: sidebar toggle, empty breadcrumb, search box placeholder (⌘P), layout toggles (side panel / bottom panel / inspector).
   - Rail: Connections, Explorer, Scripts, History, Diagrams, Settings. Selecting one swaps the side panel's placeholder content.
   - Settings rail item opens a minimal Settings view with the Theme control (Light / Dark / System cards from the mockup).

8. **Layout persistence**
   - Layout state lives in `src/state/layout.ts` as plain logic (sizes, clamping, collapsed flags, active rail item).
   - Saved to `ui_state` (debounced) and restored on launch.
   - Vitest tests for clamping and serialization.

9. **Keyboard and accessibility basics**
   - Small command registry in `src/lib/commands.ts`: each command has an id, label and default shortcut (⌘ on macOS, Ctrl elsewhere).
   - Register the layout toggles and rail switching as commands.
   - Visible focus styles; ARIA roles and labels on rail, panels, splitters (`role="separator"` with arrow-key resizing).
   - Vitest tests for shortcut matching per platform.

10. **Verify**
    - Run through the "Done when" list on Windows.
    - Update `2-roadmap.md` status: milestone 1 done, milestone 2 next.


## Open questions

- None blocking. The exact Contrast token values come from the design project in step 3.
