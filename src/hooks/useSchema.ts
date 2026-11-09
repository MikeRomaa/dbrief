import { useEffect } from "react";

import { useStore } from "@/hooks/useStore";
import { ensureSchema, type SchemaState, schemaStore } from "@/lib/schema/schemaStore";

/** The schema of a connection, loading it on first use. */
export function useSchema(connectionId: string | null): SchemaState | undefined {
    const map = useStore(schemaStore);
    useEffect(() => {
        if (connectionId) ensureSchema(connectionId);
    }, [connectionId]);
    return connectionId ? map.get(connectionId) : undefined;
}
