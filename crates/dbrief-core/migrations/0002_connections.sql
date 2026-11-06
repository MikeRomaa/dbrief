-- Folders nest; deleting a folder deletes its subfolders and their connections.
CREATE TABLE folders (
    id         TEXT PRIMARY KEY NOT NULL,
    parent_id  TEXT REFERENCES folders (id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    sort_order REAL NOT NULL
);

CREATE INDEX folders_parent_id ON folders (parent_id);

-- Secrets (passwords, SSH passwords and passphrases) are never stored here.
CREATE TABLE connections (
    id                    TEXT PRIMARY KEY NOT NULL,
    folder_id             TEXT REFERENCES folders (id) ON DELETE CASCADE,
    name                  TEXT NOT NULL,
    engine                TEXT NOT NULL CHECK (engine IN ('postgres', 'sqlite')),
    access_level          TEXT NOT NULL CHECK (access_level IN ('ro', 'rw', 'ddl')),
    color_tag             TEXT,
    pinned                INTEGER NOT NULL DEFAULT 0,
    sort_order            REAL NOT NULL,

    host                  TEXT,
    port                  INTEGER,
    database              TEXT,
    username              TEXT,
    ssl_mode              TEXT,
    ca_cert_path          TEXT,

    file_path             TEXT,

    ssh                   TEXT,

    connect_timeout_s     INTEGER,
    query_timeout_s       INTEGER,
    default_schema        TEXT,
    startup_sql           TEXT,

    confirm_before_commit INTEGER NOT NULL DEFAULT 0,
    manual_transactions   INTEGER NOT NULL,

    created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    last_used_at          TEXT
);

CREATE INDEX connections_folder_id ON connections (folder_id);
