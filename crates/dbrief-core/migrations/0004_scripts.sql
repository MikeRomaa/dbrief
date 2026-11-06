-- Per-script settings, keyed by the script's path relative to the scripts folder ("/" separators).
-- The files themselves live on disk.
CREATE TABLE scripts (
    path          TEXT PRIMARY KEY NOT NULL,
    connection_id TEXT REFERENCES connections (id) ON DELETE SET NULL,
    schema        TEXT,
    params        TEXT,
    updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
