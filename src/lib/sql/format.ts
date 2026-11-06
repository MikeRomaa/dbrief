import { format } from "sql-formatter";

import type { Dialect } from "@/lib/sql/statements";

/**
 * Formats SQL for the connection's dialect, as the script editor's Format does. SQL the formatter
 * can't parse is returned as it was, so DDL always shows.
 */
export function formatSql(sql: string, dialect: Dialect): string {
    try {
        return format(sql, { language: dialect === "sqlite" ? "sqlite" : "postgresql", tabWidth: 4 }).trim();
    } catch {
        return sql.trim();
    }
}
