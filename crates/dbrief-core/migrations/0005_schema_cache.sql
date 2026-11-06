-- Local copy of each connection's schema, for the Explorer, search (⌘P) and autocomplete. A refresh
-- replaces a connection's rows in one transaction. `schema` is the PostgreSQL schema, or the SQLite
-- database name ("main", or an attached database).
CREATE TABLE schema_objects (
    id             INTEGER PRIMARY KEY,
    connection_id  TEXT NOT NULL REFERENCES connections (id) ON DELETE CASCADE,
    schema         TEXT NOT NULL,
    name           TEXT NOT NULL,
    kind           TEXT NOT NULL,
    parent         TEXT,
    detail         TEXT,
    estimated_rows INTEGER,
    size_bytes     INTEGER
);

CREATE INDEX schema_objects_connection ON schema_objects (connection_id, schema, name);

CREATE TABLE schema_columns (
    connection_id TEXT NOT NULL REFERENCES connections (id) ON DELETE CASCADE,
    schema        TEXT NOT NULL,
    table_name    TEXT NOT NULL,
    ordinal       INTEGER NOT NULL,
    name          TEXT NOT NULL,
    type_name     TEXT NOT NULL,
    nullable      INTEGER NOT NULL,
    default_value TEXT,
    pk_ordinal    INTEGER,
    PRIMARY KEY (connection_id, schema, table_name, ordinal)
);

-- Data grid column layout per table: order, widths and hidden columns, as JSON owned by the frontend.
CREATE TABLE table_layouts (
    connection_id TEXT NOT NULL REFERENCES connections (id) ON DELETE CASCADE,
    schema        TEXT NOT NULL,
    table_name    TEXT NOT NULL,
    layout        TEXT NOT NULL,
    PRIMARY KEY (connection_id, schema, table_name)
);

ALTER TABLE connections ADD COLUMN schema_refreshed_at TEXT;
