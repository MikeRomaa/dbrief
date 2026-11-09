import { Check, ChevronDown } from "lucide-react";
import { type KeyboardEvent, useEffect, useId, useRef, useState } from "react";

import { useCloseOnScroll, usePopoverPosition } from "@/hooks/usePopover";

import styles from "@/components/ui/Select.module.css";

/** One choice. `muted` draws it as a non-value, such as "None" or a default. */
export interface SelectOption<T extends string> {
    value: T;
    label: string;
    muted?: boolean;
}

interface SelectProps<T extends string> {
    value: T;
    options: readonly SelectOption<T>[];
    onChange: (value: T) => void;
    labelledBy: string;
    mono?: boolean;
}

/** Typed letters within this time add to the type-to-find text. */
const TYPEAHEAD_MS = 600;

/**
 * A dropdown drawn by the app rather than the OS, so options can be styled (WAI-ARIA select-only
 * combobox).
 */
export function Select<T extends string>({ value, options, onChange, labelledBy, mono = false }: SelectProps<T>) {
    const [open, setOpen] = useState(false);
    const [active, setActive] = useState(0);
    const triggerRef = useRef<HTMLButtonElement>(null);
    const listId = useId();
    const typeahead = useRef({ text: "", at: 0 });

    const selectedIndex = Math.max(
        0,
        options.findIndex((o) => o.value === value),
    );
    const selected = options[selectedIndex];

    const show = (index = selectedIndex) => {
        setActive(index);
        setOpen(true);
    };

    const close = (refocus: boolean) => {
        setOpen(false);
        if (refocus) triggerRef.current?.focus();
    };

    const pick = (index: number) => {
        const option = options[index];
        if (option) onChange(option.value);
        close(true);
    };

    /** The next option whose label starts with what's been typed, searching from `from`. */
    const find = (key: string, from: number): number | undefined => {
        const now = performance.now();
        const t = typeahead.current;
        t.text = now - t.at < TYPEAHEAD_MS ? t.text + key.toLowerCase() : key.toLowerCase();
        t.at = now;

        for (let step = 0; step < options.length; step++) {
            const i = (from + step) % options.length;
            if (options[i]?.label.toLowerCase().startsWith(t.text)) return i;
        }
        return undefined;
    };

    const onTriggerKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
        if (["ArrowDown", "ArrowUp", "Enter", " "].includes(e.key)) {
            e.preventDefault();
            show();
        } else if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
            // Type-to-find while closed changes the value directly, like a native select.
            const i = find(e.key, selectedIndex + 1);
            if (i !== undefined) onChange(options[i]?.value ?? value);
        }
    };

    const onListKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
        const last = options.length - 1;
        const move = (i: number) => {
            e.preventDefault();
            setActive(Math.min(Math.max(i, 0), last));
        };

        switch (e.key) {
            case "ArrowDown":
                return move(active + 1);
            case "ArrowUp":
                return move(active - 1);
            case "Home":
            case "PageUp":
                return move(0);
            case "End":
            case "PageDown":
                return move(last);
            case "Enter":
            case " ":
                e.preventDefault();
                return pick(active);
            case "Escape":
                e.preventDefault();
                return close(true);
            case "Tab":
                return close(false);
        }

        if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
            const i = find(e.key, active + 1);
            if (i !== undefined) move(i);
        }
    };

    return (
        <>
            <button
                ref={triggerRef}
                type="button"
                id={`${listId}-trigger`}
                role="combobox"
                aria-haspopup="listbox"
                aria-expanded={open}
                aria-controls={open ? listId : undefined}
                aria-labelledby={`${labelledBy} ${listId}-trigger`}
                className={styles.trigger}
                data-mono={mono || undefined}
                data-muted={selected?.muted || undefined}
                onClick={() => (open ? close(false) : show())}
                onKeyDown={onTriggerKeyDown}
            >
                <span className={styles.value}>{selected?.label}</span>
                <ChevronDown size={12} className={styles.chevron} aria-hidden="true" />
            </button>
            {open && triggerRef.current && (
                <Listbox
                    id={listId}
                    anchor={triggerRef.current}
                    labelledBy={labelledBy}
                    options={options}
                    value={value}
                    active={active}
                    mono={mono}
                    onActive={setActive}
                    onPick={pick}
                    onClose={close}
                    onKeyDown={onListKeyDown}
                />
            )}
        </>
    );
}

interface ListboxProps<T extends string> {
    id: string;
    anchor: HTMLElement;
    labelledBy: string;
    options: readonly SelectOption<T>[];
    value: T;
    active: number;
    mono: boolean;
    onActive: (index: number) => void;
    onPick: (index: number) => void;
    onClose: (refocus: boolean) => void;
    onKeyDown: (e: KeyboardEvent<HTMLDivElement>) => void;
}

function Listbox<T extends string>({
    id,
    anchor,
    labelledBy,
    options,
    value,
    active,
    mono,
    onActive,
    onPick,
    onClose,
    onKeyDown,
}: ListboxProps<T>) {
    const ref = useRef<HTMLDivElement>(null);
    const position = usePopoverPosition(ref, anchor, "start", true);
    useCloseOnScroll(ref, () => onClose(false));

    const placed = position !== null;
    useEffect(() => {
        if (placed) ref.current?.focus();
    }, [placed]);

    useEffect(() => {
        ref.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
    }, [active]);

    return (
        <div
            ref={ref}
            id={id}
            role="listbox"
            aria-labelledby={labelledBy}
            aria-activedescendant={`${id}-${active}`}
            tabIndex={-1}
            className={styles.list}
            data-mono={mono || undefined}
            style={position ?? { visibility: "hidden" }}
            onKeyDown={onKeyDown}
            onBlur={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node | null) && e.relatedTarget !== anchor) {
                    onClose(false);
                }
            }}
        >
            {options.map((option, i) => (
                // biome-ignore lint/a11y/useFocusableInteractive: options are reached through aria-activedescendant on the listbox
                // biome-ignore lint/a11y/useKeyWithClickEvents: the listbox handles the keyboard for all options
                <div
                    key={option.value}
                    id={`${id}-${i}`}
                    role="option"
                    data-index={i}
                    aria-selected={option.value === value}
                    data-active={i === active || undefined}
                    data-muted={option.muted || undefined}
                    className={styles.option}
                    onPointerMove={() => onActive(i)}
                    onClick={() => onPick(i)}
                >
                    <span className={styles.value}>{option.label}</span>
                    {option.value === value && <Check size={12} className={styles.check} aria-hidden="true" />}
                </div>
            ))}
        </div>
    );
}
