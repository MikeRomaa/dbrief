-- Server version from the last successful connect, e.g. "PostgreSQL 17.2", for the Connections view.
ALTER TABLE connections ADD COLUMN server_version TEXT;
