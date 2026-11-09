import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { Shell } from "@/components/shell/Shell";

import "@/theme/global.css";
import "@/theme/tokens.css";

const root = document.getElementById("root");
if (!root) {
    throw new Error("missing #root");
}

createRoot(root).render(
    <StrictMode>
        <Shell />
    </StrictMode>,
);
