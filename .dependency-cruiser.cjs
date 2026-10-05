/**
 * Direction rules for the interface (BRIEF §4.3). The Vitest direction test runs these
 * against src/ and against fixtures that break each rule on purpose.
 * @type {import('dependency-cruiser').IConfiguration}
 */
module.exports = {
  forbidden: [
    {
      name: "only-backend-talks-to-tauri",
      comment: "Only src/backend.ts may import @tauri-apps/api.",
      severity: "error",
      from: { pathNot: "^src/backend\\.ts$" },
      to: { path: "@tauri-apps/" },
    },
    {
      name: "rings-do-not-import-features",
      comment: "shell, kit, editor and reader never import features.",
      severity: "error",
      from: { path: "^src/(shell|kit|editor|reader)/" },
      to: { path: "^src/features/" },
    },
    {
      name: "feature-not-to-feature",
      comment: "A feature never imports another feature.",
      severity: "error",
      from: { path: "^src/features/([^/]+)/" },
      to: { path: "^src/features/", pathNot: "^src/features/$1/" },
    },
    {
      name: "react-only-in-boards",
      comment: "The interface uses no UI framework (BRIEF §3); React and Excalidraw are allowed only inside the boards feature, which loads them on demand (decision 0061).",
      severity: "error",
      from: { pathNot: "^src/features/boards/" },
      to: { path: "(^|/)node_modules/(react|react-dom|@excalidraw/[^/]+)/|^(react|react-dom|@excalidraw/excalidraw)($|/)" },
    },
    {
      name: "generated-is-leaf",
      comment: "Generated types import only generated types.",
      severity: "error",
      from: { path: "^src/generated/" },
      to: { pathNot: "^src/generated/" },
    },
    {
      name: "no-circular",
      severity: "error",
      from: {},
      to: { circular: true },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    exclude: { path: "\\.test\\.ts$" },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: "tsconfig.json" },
    enhancedResolveOptions: { exportsFields: ["exports"], conditionNames: ["import", "require", "node", "default", "types"] },
  },
};
