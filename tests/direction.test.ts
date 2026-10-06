/**
 * Interface direction tests (BRIEF §4.3), using the same dependency-cruiser rules as `npm run lint:deps`.
 */
import { describe, expect, it } from "vitest";
import { cruise, type ICruiseResult } from "dependency-cruiser";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const config = require("../.dependency-cruiser.cjs");
const root = path.resolve(import.meta.dirname, "..");

async function run(baseDir: string): Promise<ICruiseResult> {
  const result = await cruise(["src"], { ...config.options, validate: true, ruleSet: { forbidden: config.forbidden }, baseDir }, undefined, {
    tsConfig: undefined,
  });
  return result.output as ICruiseResult;
}

function violated(r: ICruiseResult): string[] {
  return r.summary.violations.map((v) => `${v.rule.name}: ${v.from} -> ${v.to}`).sort();
}

describe("interface direction", () => {
  it("src/ follows every rule", async () => {
    const r = await run(root);
    expect(r.summary.totalCruised).toBeGreaterThan(3);
    expect(violated(r)).toEqual([]);
  });

  it("the rules catch each forbidden import", async () => {
    const r = await run(path.join(root, "tests/fixtures/direction-bad"));
    const v = violated(r);
    expect(v.some((s) => s.startsWith("only-backend-talks-to-tauri: src/kit/sneaky.ts"))).toBe(true);
    expect(v.some((s) => s.startsWith("only-backend-talks-to-tauri: src/backend.ts"))).toBe(false);
    expect(v).toContain("rings-do-not-import-features: src/shell/shell.ts -> src/features/notes/index.ts");
    expect(v).toContain("rings-do-not-import-features: src/editor/ed.ts -> src/features/notes/index.ts");
    expect(v).toContain("feature-not-to-feature: src/features/notes/index.ts -> src/features/daily/index.ts");
    // React and Excalidraw only inside boards.
    expect(v.some((s) => s.startsWith("react-only-in-boards: src/features/notes/index.ts"))).toBe(true);
    expect(v.some((s) => s.startsWith("react-only-in-boards: src/features/boards/"))).toBe(false);
    // The board engine is loaded on demand, never imported outright.
    expect(v).toContain("board-engine-loads-on-demand: src/features/boards/page.ts -> src/features/boards/engine.ts");
    expect(v.some((s) => s.startsWith("board-engine-loads-on-demand: src/features/boards/lazy.ts"))).toBe(false);
  });
});
