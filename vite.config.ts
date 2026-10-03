import { defineConfig } from "vitest/config";
import path from "node:path";

const mockBackend = { find: /^(\.{1,2}\/)+backend$/, replacement: path.resolve(import.meta.dirname, "tests/mock/backend.ts") };

// Tauri expects a fixed dev port and must see Rust errors.
export default defineConfig(({ mode }) => ({
  clearScreen: false,
  server: { port: mode === "mock" ? 1421 : 1420, strictPort: true, watch: { ignored: ["**/src-tauri/**", "**/crates/**", "**/target/**"] } },
  envPrefix: ["VITE_", "TAURI_ENV_"],
  // The browser preview and the tests talk to an in-process mock instead of Tauri.
  resolve: { alias: mode === "mock" || mode === "test" ? [mockBackend] : [] },
  build: {
    target: "safari18",
    minify: process.env.TAURI_ENV_DEBUG ? false : "esbuild",
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
  },
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.ts", "tests/**/*.test.ts"],
    alias: [mockBackend],
  },
}));
