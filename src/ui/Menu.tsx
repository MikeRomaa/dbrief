import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";

import { useCloseOnScroll, usePopoverPosition } from "@/hooks/usePopover";
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
    anchor: Pick<HTMLElement, "getBoundingClientRect">;
    align: "start" | "end";
    entries: MenuEntry[];
    onClose: (refocus: boolean) => void;
}

/**
 * A context menu at a point (right-click, or the Menu key / Shift+F10 at the focused item). Focus
 * returns to `returnFocus` when it closes with Escape.
 */
export function ContextMenu({
    label,
    at,
    entries,
    onClose,
    returnFocus,
}: {
    label: string;
    at: { x: number; y: number };
    entries: MenuEntry[];
    onClose: () => void;
    returnFocus?: HTMLElement | null;
}) {
    // Stable per point: the popup measures again whenever its anchor changes.
    const anchor = useMemo(() => ({ getBoundingClientRect: () => new DOMRect(at.x, at.y, 0, 0) }), [at.x, at.y]);
    return (
        <Menu
            label={label}
            anchor={anchor}
            align="start"
            entries={entries}
            onClose={(refocus) => {
                onClose();
                if (refocus) returnFocus?.focus();
            }}
        />
    );
}

function Menu({ label, anchor, align, entries, onClose }: MenuProps) {
    const ref = useRef<HTMLDivElement>(null);

    // Fixed position, so scrolling containers never clip the menu.
    const position = usePopoverPosition(ref, anchor, align);
    useCloseOnScroll(ref, () => onClose(false));

    // Focus the first item once the menu is placed; a hidden element can't take focus.
    const placed = position !== null;
    useEffect(() => {
        if (placed) {
            ref.current?.querySelector<HTMLElement>('[role="menuitem"]:not(:disabled)')?.focus();
        }
    }, [placed]);

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
