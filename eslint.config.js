import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";

export default tseslint.config(
  { ignores: ["dist/", "node_modules/", "src-tauri/", "crates/", "target/", "src/generated/", "vendor/", "tests/fixtures/", "public/"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.browser } },
    rules: {
      // The one door: only backend.ts talks to the Transport (also checked by dependency-cruiser).
      "no-restricted-imports": ["error", { patterns: [{ group: ["@tauri-apps/*"], message: "Only src/backend.ts may import @tauri-apps/*." }] }],
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },
  { files: ["src/backend.ts"], rules: { "no-restricted-imports": "off" } },
  { files: ["*.js", "*.cjs", "*.mjs", "scripts/**"], languageOptions: { globals: { ...globals.node } } },
);
