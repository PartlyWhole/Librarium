import { defineConfig } from "vitest/config";

/**
 * Excalidraw (boards) lists a public CDN (esm.sh) as a second source for every font. The app
 * serves the fonts itself (public/excalidraw/, see scripts/assets.mjs) and never goes to the
 * network, so that second source is pointed at the same local folder. Applied to the dev
 * server's pre-bundled copy as well as to builds.
 */
const EXCALIDRAW_CDN = /`https:\/\/esm\.sh\/\$\{.*?\}\/dist\/prod\/`/g;
/**
 * Excalidraw draws a link icon by every element with a link, and has no option to leave it out.
 * Its check asks the board first (`globalThis.librariumLinkIcon`, set in src/boards/engine.ts):
 * cards, text boxes and texts open their links themselves. The same check in the dev build and
 * the minified one.
 */
const LINK_ICON = /(\(\s*(\w+),\s*\w+,\s*(\w+),\s*\w+\s*\)\s*=>\s*\{\s*if\s*\(\s*)\2\.link\s*&&\s*!\3\.selectedElementIds\[\2\.id\]/;
const excalidrawPatched = {
  name: "librarium:excalidraw",
  transform(code: string, id: string) {
    if (!id.includes("@excalidraw/excalidraw") || (!code.includes("esm.sh") && !LINK_ICON.test(code))) return null;
    // A full address (fonts' addresses are made with `new URL(name, base)`), on the app's origin.
    const local = 'new URL("/excalidraw/", globalThis.location?.href ?? "http://localhost/").href';
    const out = code
      .replace(EXCALIDRAW_CDN, local)
      .replace(/https:\/\/esm\.sh\//g, "/excalidraw/")
      .replace(LINK_ICON, (_m, head: string, el: string, state: string) => `${head}${el}.link && globalThis.librariumLinkIcon?.(${el}) !== false && !${state}.selectedElementIds[${el}.id]`);
    return { code: out, map: null };
  },
};

// Tauri expects a fixed dev port and must see Rust errors.
export default defineConfig({
  clearScreen: false,
  plugins: [excalidrawPatched],
  optimizeDeps: { rolldownOptions: { plugins: [excalidrawPatched] } },
  server: { port: 1420, strictPort: true, watch: { ignored: ["**/src-tauri/**"] } },
  envPrefix: ["VITE_", "TAURI_ENV_"],
  build: {
    target: "safari18",
    minify: !process.env.TAURI_ENV_DEBUG,
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
  },
  test: { include: ["src/**/*.test.ts"] },
});
