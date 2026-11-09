import { homeDir } from "@tauri-apps/api/path";
import { useCallback, useEffect, useMemo, useState } from "react";

import { type ConnectionTree, indexTree, type SortOrder, type TreeIndex } from "@/lib/connections/connectionTree";
import { backend, errorMessage } from "@/lib/ipc/backend";
import type { SessionInfo } from "@/lib/ipc/bindings";
import { events } from "@/lib/ipc/bindings";

/** `ui_state` keys for the view's preferences. */
const COLLAPSED_KEY = "connections.collapsed";
const SORT_KEY = "connections.sort";

const SORT_ORDERS: readonly SortOrder[] = ["manual", "name", "last-used"];

/** The connection tree, open sessions and view preferences. */
export interface ConnectionsState {
    tree: ConnectionTree;
    index: TreeIndex;
    sessions: SessionInfo[];
    persistentSecrets: boolean;
    home: string | null;
    collapsed: ReadonlySet<string>;
    sort: SortOrder;
    error: string | null;
    setCollapsed: (collapsed: ReadonlySet<string>) => void;
    setSort: (sort: SortOrder) => void;
    dismissError: () => void;
    report: (message: string) => void;
    reload: () => Promise<void>;
    run: <T>(action: () => Promise<T>) => Promise<T | undefined>;
}

const EMPTY_TREE: ConnectionTree = { pinned: [], root: [] };

export function useConnections(): ConnectionsState {
    const [tree, setTree] = useState<ConnectionTree>(EMPTY_TREE);
    const [sessions, setSessions] = useState<SessionInfo[]>([]);
    const [persistentSecrets, setPersistentSecrets] = useState(true);
    const [home, setHome] = useState<string | null>(null);
    const [collapsed, setCollapsedState] = useState<ReadonlySet<string>>(new Set());
    const [sort, setSortState] = useState<SortOrder>("manual");
    const [error, setError] = useState<string | null>(null);

    const reload = useCallback(async () => {
        const [nextTree, nextSessions] = await Promise.all([backend.connectionTree(), backend.listSessions()]);
        setTree(nextTree);
        setSessions(nextSessions);
    }, []);

    // Sessions open and close from tabs, the Explorer and search too.
    useEffect(() => {
        const unlisten = events.sessionsChanged.listen(() => {
            backend
                .listSessions()
                .then(setSessions)
                .catch(() => {});
        });
        return () => void unlisten.then((off) => off());
    }, []);

    useEffect(() => {
        reload().catch((e: unknown) => setError(`Could not load connections: ${errorMessage(e)}`));
        backend
            .secretStorePersistent()
            .then(setPersistentSecrets)
            .catch(() => {});
        homeDir()
            .then(setHome)
            .catch(() => {});

        backend
            .getUiState(COLLAPSED_KEY)
            .then((raw) => {
                const ids: unknown = raw ? JSON.parse(raw) : [];
                if (Array.isArray(ids)) {
                    setCollapsedState(new Set(ids.filter((id): id is string => typeof id === "string")));
                }
            })
            .catch(() => {});
        backend
            .getUiState(SORT_KEY)
            .then((raw) => {
                const found = SORT_ORDERS.find((s) => s === raw);
                if (found) setSortState(found);
            })
            .catch(() => {});
    }, [reload]);

    const setCollapsed = useCallback((next: ReadonlySet<string>) => {
        setCollapsedState(next);
        backend.setUiState(COLLAPSED_KEY, JSON.stringify([...next])).catch(() => {});
    }, []);

    const setSort = useCallback((next: SortOrder) => {
        setSortState(next);
        backend.setUiState(SORT_KEY, next).catch(() => {});
    }, []);

    const run = useCallback(
        async <T>(action: () => Promise<T>): Promise<T | undefined> => {
            try {
                const result = await action();
                setError(null);
                return result;
            } catch (e) {
                setError(errorMessage(e));
                return undefined;
            } finally {
                await reload().catch(() => {});
            }
        },
        [reload],
    );

    const index = useMemo(() => indexTree(tree), [tree]);

    return {
        tree,
        index,
        sessions,
        persistentSecrets,
        home,
        collapsed,
        sort,
        error,
        setCollapsed,
        setSort,
        dismissError: () => setError(null),
        report: setError,
        reload,
        run,
    };
}
