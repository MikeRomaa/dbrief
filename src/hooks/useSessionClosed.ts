import { useEffect, useRef } from "react";

import type { SessionInfo } from "@/lib/ipc/bindings";

/**
 * Calls `onClosed` when `session` leaves the open sessions (a disconnect from elsewhere). The list
 * catches up with a just-opened session a moment later, so a session counts as closed only once
 * the list has shown it.
 */
export function useSessionClosed(session: SessionInfo | null, sessions: SessionInfo[], onClosed: () => void) {
    const seen = useRef<string | null>(null);
    const closed = useRef(onClosed);
    closed.current = onClosed;
    useEffect(() => {
        if (!session) {
            seen.current = null;
            return;
        }
        if (sessions.some((s) => s.id === session.id)) seen.current = session.id;
        else if (seen.current === session.id) {
            seen.current = null;
            closed.current();
        }
    }, [session, sessions]);
}
