import babel from "@rolldown/plugin-babel";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
    plugins: [react(), babel({ presets: [reactCompilerPreset()] })],
    resolve: { tsconfigPaths: true },
    clearScreen: false,
    server: {
        port: 1420,
        strictPort: true,
        host: host || false,
        hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
        watch: { ignored: ["**/src-tauri/**", "**/crates/**", "**/target/**"] },
    },
    envPrefix: ["VITE_", "TAURI_ENV_*"],
    build: {
        target: process.env.TAURI_ENV_PLATFORM === "windows" ? "chrome120" : "safari16",
        sourcemap: !!process.env.TAURI_ENV_DEBUG,
    },
    test: {
        include: ["tests/**/*.test.ts"],
        environment: "node",
    },
});
