import { platform } from "@tauri-apps/plugin-os";
import type { CSSProperties } from "react";

import logo from "@/assets/logo.svg";
import { WindowControls } from "@/shell/WindowControls";

import styles from "@/shell/TopBar.module.css";

/**
 * Custom title bar (replaces the OS one). Empty areas drag the window; double-click maximizes.
 * On macOS the native traffic lights stay, so the bar leaves room for them on the left.
 */
export function TopBar({ tint }: { tint?: string } = {}) {
    return (
        <header
            className={styles.topBar}
            data-platform={platform()}
            data-tinted={tint ? true : undefined}
            style={tint ? ({ "--bar-tint": tint } as CSSProperties) : undefined}
            data-tauri-drag-region
        >
            <span className={styles.app} data-tauri-drag-region>
                <img className={styles.logo} src={logo} width={20} height={20} alt="" />
                <span className={styles.wordmark} role="img" aria-label="DBrief" data-tauri-drag-region />
            </span>
            <nav className={styles.breadcrumb} aria-label="Breadcrumb" data-tauri-drag-region>
                <ol data-tauri-drag-region />
            </nav>
            {platform() !== "macos" && <WindowControls />}
        </header>
    );
}
