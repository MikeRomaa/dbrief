import type { CSSProperties } from "react";

import postgresql from "@/assets/engines/postgresql.svg";
import sqlite from "@/assets/engines/sqlite.svg";
import { engines } from "@/lib/engine";
import type { Engine } from "@/lib/ipc/bindings";

const ICONS: Record<Engine, string> = { postgres: postgresql, sqlite };

interface EngineIconProps {
    engine: Engine;
    size?: number;
    labelled?: boolean;
}

/** Engine logo in the current text color (a CSS mask over the SVG). Decorative unless `labelled`. */
export function EngineIcon({ engine, size = 14, labelled = false }: EngineIconProps) {
    const mask = `url("${ICONS[engine]}") center / contain no-repeat`;
    const style: CSSProperties = {
        display: "inline-block",
        flex: "none",
        width: size,
        height: size,
        background: "currentColor",
        WebkitMask: mask,
        mask,
    };

    return labelled ? (
        <span role="img" aria-label={engines[engine].name} style={style} />
    ) : (
        <span aria-hidden="true" style={style} />
    );
}
