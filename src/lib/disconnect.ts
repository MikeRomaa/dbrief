/**
 * Disconnecting a connection closes every tab session on it. Tabs with an open transaction must be
 * committed or rolled back first; the editor area registers the check that asks about them.
 */
type Guard = (connectionId: string) => Promise<boolean>;

let guard: Guard = async () => true;

export function setDisconnectGuard(next: Guard): () => void {
    guard = next;
    return () => {
        if (guard === next) guard = async () => true;
    };
}

/** Resolves to true when the connection can be disconnected (nothing open, or the user settled it). */
export function confirmDisconnect(connectionId: string): Promise<boolean> {
    return guard(connectionId);
}
