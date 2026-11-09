import { getCurrentWindow } from "@tauri-apps/api/window";
import { Copy, Minus, Square, X } from "lucide-react";
import { useEffect, useState } from "react";

import { tooltip } from "@/lib/shell/tooltip";

import styles from "@/components/shell/WindowControls.module.css";

/** Minimize / maximize / close for Windows and Linux (the OS title bar is turned off). */
export function WindowControls() {
    const [maximized, setMaximized] = useState(false);

    useEffect(() => {
        const win = getCurrentWindow();
        const sync = () => {
            win.isMaximized()
                .then(setMaximized)
                .catch(() => {});
        };

        sync();
        const unlisten = win.onResized(sync);

        return () => {
            void unlisten.then((off) => off());
        };
    }, []);

    const run = (action: "minimize" | "toggleMaximize" | "close") => {
        void getCurrentWindow()[action]();
    };

    return (
        <div className={styles.controls}>
            <button
                type="button"
                className={styles.button}
                aria-label="Minimize"
                {...tooltip("Minimize")}
                onClick={() => run("minimize")}
            >
                <Minus size={14} />
            </button>
            <button
                type="button"
                className={styles.button}
                aria-label={maximized ? "Restore" : "Maximize"}
                {...tooltip(maximized ? "Restore" : "Maximize")}
                onClick={() => run("toggleMaximize")}
            >
                {maximized ? <Copy size={12} /> : <Square size={12} />}
            </button>
            <button
                type="button"
                className={styles.button}
                data-close
                aria-label="Close"
                {...tooltip("Close")}
                onClick={() => run("close")}
            >
                <X size={14} />
            </button>
        </div>
    );
}
