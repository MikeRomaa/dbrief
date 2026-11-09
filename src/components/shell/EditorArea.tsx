import type { ReactNode } from "react";

import styles from "@/components/shell/EditorArea.module.css";

/** Editor groups region. Real tabs and splits arrive with content in later milestones. */
export function EditorArea({ children }: { children?: ReactNode }) {
    return (
        <main id="editor-area" aria-label="Editor" className={styles.editorArea}>
            {children ?? (
                <div className={styles.empty}>
                    <p>No open tabs</p>
                </div>
            )}
        </main>
    );
}
