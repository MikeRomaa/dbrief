/**
 * Index to move focus to inside a roving-focus group (tab list, radio group), or
 * `undefined` if the key does not move focus. Wraps around at both ends.
 */
export function nextRovingIndex(
    current: number,
    count: number,
    key: string,
    orientation: "horizontal" | "vertical",
): number | undefined {
    if (count === 0) {
        return undefined;
    }

    const prev = orientation === "vertical" ? "ArrowUp" : "ArrowLeft";
    const next = orientation === "vertical" ? "ArrowDown" : "ArrowRight";

    switch (key) {
        case prev:
            return (current - 1 + count) % count;
        case next:
            return (current + 1) % count;
        case "Home":
            return 0;
        case "End":
            return count - 1;
        default:
            return undefined;
    }
}

/** Keydown handler for a container whose children match `selector`; moves DOM focus. */
export function handleRovingKeyDown(
    event: { key: string; currentTarget: HTMLElement; preventDefault(): void },
    selector: string,
    orientation: "horizontal" | "vertical",
): HTMLElement | undefined {
    const items = [...event.currentTarget.querySelectorAll<HTMLElement>(selector)];
    const current = items.indexOf(document.activeElement as HTMLElement);
    const index = nextRovingIndex(Math.max(current, 0), items.length, event.key, orientation);

    if (index === undefined) {
        return undefined;
    }

    event.preventDefault();
    const target = items[index];
    target?.focus();

    return target;
}
