import { defineConfig } from "vitest/config";
import path from "node:path";

const mockBackend = { find: /^(\.{1,2}\/)+backend$/, replacement: path.resolve(import.meta.dirname, "tests/mock/backend.ts") };

/**
 * Excalidraw (boards) lists a public CDN (esm.sh) as a second source for every font. The app
 * serves the fonts itself (public/excalidraw/, see scripts/copy-pdfjs.mjs) and never goes to the
 * network, so that second source is pointed at the same local folder. Applied to the dev
 * server's pre-bundled copy as well as to builds.
 */
const EXCALIDRAW_CDN = /`https:\/\/esm\.sh\/\$\{.*?\}\/dist\/prod\/`/g;
const excalidrawOffline = {
  name: "librarium:excalidraw-offline",
  transform(code: string, id: string) {
    if (!id.includes("@excalidraw/excalidraw") || !code.includes("esm.sh")) return null;
    // A full address (fonts' addresses are made with `new URL(name, base)`), on the app's origin.
    const local = 'new URL("/excalidraw/", globalThis.location?.href ?? "http://localhost/").href';
    const out = code.replace(EXCALIDRAW_CDN, local).replace(/https:\/\/esm\.sh\//g, "/excalidraw/");
    return { code: out, map: null };
  },
};

// Tauri expects a fixed dev port and must see Rust errors.
export default defineConfig(({ mode }) => ({
  clearScreen: false,
  plugins: [excalidrawOffline],
  optimizeDeps: { rolldownOptions: { plugins: [excalidrawOffline] } },
  server: { port: mode === "mock" ? 1421 : 1420, strictPort: true, watch: { ignored: ["**/src-tauri/**", "**/crates/**", "**/target/**"] } },
  envPrefix: ["VITE_", "TAURI_ENV_"],
  // The browser preview and the tests talk to an in-process mock instead of Tauri.
  resolve: { alias: mode === "mock" || mode === "test" ? [mockBackend] : [] },
  build: {
    target: "safari18",
    minify: !process.env.TAURI_ENV_DEBUG,
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
  },
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.ts", "tests/**/*.test.ts"],
    alias: [mockBackend],
    setupFiles: ["tests/setup.ts"],
  },
}));
