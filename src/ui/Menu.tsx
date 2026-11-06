import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";

import { handleRovingKeyDown } from "@/lib/roving";

import styles from "@/ui/Menu.module.css";

/** A menu item, with an optional `hint` shown on the right (e.g. "file"), or a separator. */
export type MenuEntry =
    | {
          label: string;
          icon?: ReactNode;
          hint?: string;
          disabled?: boolean;
          danger?: boolean;
          onSelect: () => void;
      }
    | "separator";

interface MenuButtonProps {
    label: string;
    entries: MenuEntry[];
    align?: "start" | "end";
    className?: string;
    children: ReactNode;
    attrs?: Record<string, string>;
    tabIndex?: number;
}

/** A button that opens a menu below it (or above, near the bottom of the window). */
export function MenuButton({ label, entries, align = "start", className, children, attrs, tabIndex }: MenuButtonProps) {
    const [open, setOpen] = useState(false);
    const buttonRef = useRef<HTMLButtonElement>(null);

    return (
        <>
            <button
                ref={buttonRef}
                type="button"
                className={className}
                tabIndex={tabIndex}
                aria-label={label}
                aria-haspopup="menu"
                aria-expanded={open}
                onClick={(e) => {
                    e.stopPropagation();
                    setOpen((o) => !o);
                }}
                onKeyDown={(e) => {
                    if (e.key === "ArrowDown") {
                        e.preventDefault();
                        setOpen(true);
                    }
                }}
                {...attrs}
            >
                {children}
            </button>
            {open && buttonRef.current && (
                <Menu
                    label={label}
                    anchor={buttonRef.current}
                    align={align}
                    entries={entries}
                    onClose={(refocus) => {
                        setOpen(false);
                        if (refocus) buttonRef.current?.focus();
                    }}
                />
            )}
        </>
    );
}

interface MenuProps {
    label: string;
    anchor: HTMLElement;
    align: "start" | "end";
    entries: MenuEntry[];
    onClose: (refocus: boolean) => void;
}

const GAP = 4;
const MARGIN = 8;

function Menu({ label, anchor, align, entries, onClose }: MenuProps) {
    const ref = useRef<HTMLDivElement>(null);
    const [position, setPosition] = useState<{ left: number; top: number } | null>(null);

    // Fixed position, so scrolling containers never clip the menu.
    useLayoutEffect(() => {
        const menu = ref.current;
        if (!menu) return;

        const a = anchor.getBoundingClientRect();
        const width = menu.offsetWidth;
        const height = menu.offsetHeight;
        let left = align === "end" ? a.right - width : a.left;
        left = Math.min(Math.max(MARGIN, left), window.innerWidth - width - MARGIN);
        let top = a.bottom + GAP;
        if (top + height > window.innerHeight - MARGIN) {
            top = Math.max(MARGIN, a.top - GAP - height);
        }

        setPosition({ left, top });
    }, [anchor, align]);

    const onCloseRef = useRef(onClose);
    onCloseRef.current = onClose;

    // Focus the first item once the menu is placed; a hidden element can't take focus.
    const placed = position !== null;
    useEffect(() => {
        if (placed) {
            ref.current?.querySelector<HTMLElement>('[role="menuitem"]:not(:disabled)')?.focus();
        }
    }, [placed]);

    useEffect(() => {
        const close = () => onCloseRef.current(false);
        window.addEventListener("resize", close);
        window.addEventListener("wheel", close, { passive: true });
        return () => {
            window.removeEventListener("resize", close);
            window.removeEventListener("wheel", close);
        };
    }, []);

    return (
        <div
            ref={ref}
            role="menu"
            aria-label={label}
            className={styles.menu}
            style={position ?? { visibility: "hidden" }}
            onKeyDown={(e) => {
                if (e.key === "Escape" || e.key === "Tab") {
                    e.preventDefault();
                    onClose(true);
                    return;
                }

                handleRovingKeyDown(e, '[role="menuitem"]:not(:disabled)', "vertical");
            }}
            onBlur={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node | null) && e.relatedTarget !== anchor) {
                    onClose(false);
                }
            }}
        >
            {entries.map((entry, i) =>
                entry === "separator" ? (
                    // biome-ignore lint/suspicious/noArrayIndexKey: separators have no identity
                    <hr key={`sep-${i}`} className={styles.separator} />
                ) : (
                    <button
                        key={entry.label}
                        type="button"
                        role="menuitem"
                        tabIndex={-1}
                        className={styles.item}
                        data-danger={entry.danger || undefined}
                        disabled={entry.disabled}
                        onClick={(e) => {
                            e.stopPropagation();
                            onClose(false);
                            entry.onSelect();
                        }}
                    >
                        {entry.icon && <span className={styles.icon}>{entry.icon}</span>}
                        <span className={styles.label}>{entry.label}</span>
                        {entry.hint && <span className={styles.hint}>{entry.hint}</span>}
                    </button>
                ),
            )}
        </div>
    );
}
