const grouped = new Intl.NumberFormat("en-US");

/** `1,284`. */
export function formatCount(n: number): string {
    return grouped.format(n);
}

/** `950`, `1.2k`, `34k`, `1.2M`, `3.4B`: short row counts for the Explorer and estimates. */
export function compactCount(n: number): string {
    const units: [number, string][] = [
        [1e9, "B"],
        [1e6, "M"],
        [1e3, "k"],
    ];
    for (const [size, unit] of units) {
        if (n >= size) {
            const value = n / size;
            return `${value < 10 ? Math.round(value * 10) / 10 : Math.round(value)}${unit}`;
        }
    }
    return String(Math.round(n));
}

/** `512 B`, `14 kB`, `1.2 MB`, `3.4 GB` (powers of 1000, as the spec's `<binary 14 kB>`). */
export function formatBytes(n: number): string {
    const units: [number, string][] = [
        [1e12, "TB"],
        [1e9, "GB"],
        [1e6, "MB"],
        [1e3, "kB"],
    ];
    for (const [size, unit] of units) {
        if (n >= size) {
            const value = n / size;
            return `${value < 10 ? Math.round(value * 10) / 10 : Math.round(value)} ${unit}`;
        }
    }
    return `${n} B`;
}
