import { useCallback, useEffect, useRef, useState } from "react";

import { backend, errorMessage } from "@/lib/backend";
import { events, type ScriptNode } from "@/lib/bindings";

/**
 * The scripts folder as a tree, reloaded when files change on disk. `onChange` hears about every
 * changed path, so open tabs can reload their files. `error` is set when the folder can't be read
 * (for example, none is chosen yet).
 */
export interface ScriptTreeState {
    tree: ScriptNode[];
    error: string | null;
    reload: () => Promise<void>;
}

export function useScriptTree(scriptsFolder: string | undefined, onChange: (paths: string[]) => void): ScriptTreeState {
    const [tree, setTree] = useState<ScriptNode[]>([]);
    const [error, setError] = useState<string | null>(null);
    const onChangeRef = useRef(onChange);
    onChangeRef.current = onChange;

    const reload = useCallback(async () => {
        try {
            setTree(await backend.scriptTree());
            setError(null);
        } catch (e) {
            setTree([]);
            setError(errorMessage(e));
        }
    }, []);

    // Reload when the folder setting changes, too.
    useEffect(() => {
        if (scriptsFolder !== undefined) void reload();
    }, [scriptsFolder, reload]);

    useEffect(() => {
        const unlisten = events.scriptsChanged.listen((event) => {
            void reload();
            onChangeRef.current(event.payload.paths);
        });
        return () => {
            void unlisten.then((off) => off());
        };
    }, [reload]);

    return { tree, error, reload };
}
