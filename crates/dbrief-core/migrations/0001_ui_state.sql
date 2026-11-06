-- Key/value store for UI state such as layout (panel sizes, collapsed flags, active rail item).
-- Values are JSON text owned by the frontend.
CREATE TABLE ui_state (
    key        TEXT PRIMARY KEY NOT NULL,
    value      TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
