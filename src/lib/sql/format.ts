import { format } from "sql-formatter";

import { engines } from "@/lib/engine";
import type { Dialect } from "@/lib/sql/statements";

/**
 * Formats SQL for the connection's dialect, as the script editor's Format does. SQL the formatter
 * can't parse is returned as it was, so DDL always shows.
 */
export function formatSql(sql: string, dialect: Dialect): string {
    try {
        return format(sql, { language: engines[dialect].formatterLanguage, tabWidth: 4 }).trim();
    } catch {
        return sql.trim();
    }
}
