import { Search } from "lucide-react";
import { useEffect, useRef } from "react";

import styles from "@/shell/SearchPopover.module.css";

interface SearchPopoverProps {
    onClose: () => void;
}

/**
 * Search (⌘P) shown as a popover under the title bar. Results arrive in milestone 4;
 * for now it opens, takes input and closes.
 */
export function SearchPopover({ onClose }: SearchPopoverProps) {
    const inputRef = useRef<HTMLInputElement>(null);
    const popoverRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const previous = document.activeElement as HTMLElement | null;
        const popover = popoverRef.current;

        inputRef.current?.focus();

        return () => {
            // Return focus to where it was, unless the user moved it by clicking elsewhere.
            const active = document.activeElement;
            if (!active || active === document.body || popover?.contains(active)) {
                previous?.focus();
            }
        };
    }, []);

    return (
        <div
            ref={popoverRef}
            className={styles.popover}
            role="dialog"
            aria-label="Search"
            onKeyDown={(e) => {
                if (e.key === "Escape") {
                    e.preventDefault();
                    onClose();
                }
            }}
            onBlur={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
                    onClose();
                }
            }}
        >
            <div className={styles.field}>
                <Search size={14} />
                <input
                    ref={inputRef}
                    type="search"
                    className={styles.input}
                    placeholder="Search connections, tables, columns and scripts"
                    aria-label="Search connections, tables, columns and scripts"
                    spellCheck={false}
                    autoComplete="off"
                />
            </div>
            <p className={styles.empty}>No results</p>
        </div>
    );
}
