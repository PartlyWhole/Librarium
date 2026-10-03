/** Text meets WCAG 2.2 AA in both themes (BRIEF §7.3), checked from the theme's own tokens. */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const css = readFileSync(path.resolve(import.meta.dirname, "../src/shell/theme.css"), "utf8");

function block(selector: string): Record<string, string> {
  const i = css.indexOf(selector);
  const body = css.slice(css.indexOf("{", i) + 1, css.indexOf("}", i));
  return Object.fromEntries([...body.matchAll(/--([\w-]+):\s*([^;]+);/g)].map((m) => [m[1]!, m[2]!.trim()]));
}

function rgb(v: string): [number, number, number] {
  const hex = v.match(/^#([0-9a-f]{6})$/i);
  if (hex) return [0, 2, 4].map((i) => parseInt(hex[1]!.slice(i, i + 2), 16)) as [number, number, number];
  throw new Error(`not a hex colour: ${v}`);
}

function lum([r, g, b]: [number, number, number]): number {
  const f = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

function ratio(a: string, b: string): number {
  const [x, y] = [lum(rgb(a)), lum(rgb(b))].sort((p, q) => q - p);
  return (x! + 0.05) / (y! + 0.05);
}

const light = block(":root {");
const dark = { ...light, ...block(':root[data-theme="dark"]') };

describe("contrast", () => {
  for (const [name, t] of [["light", light], ["dark", dark]] as const) {
    it(`${name}: text on every background is at least 4.5:1`, () => {
      for (const fg of ["ink", "muted", "faint", "accent-text"]) {
        for (const bg of ["bg", "bg-alt", "bg-sidebar"]) {
          expect(ratio(t[fg]!, t[bg]!), `${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
        }
      }
      expect(ratio("#ffffff", t["accent-solid"]!), "white on the solid accent").toBeGreaterThanOrEqual(4.5);
    });
  }
});
