import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { formatLink, parseLinks } from "../src/editor/links";

interface Case {
  name: string;
  input: string;
  links: { raw: string; label: string; id: string | null; embed: boolean }[];
}

const cases: Case[] = JSON.parse(readFileSync(path.resolve(import.meta.dirname, "fixtures/links.json"), "utf8"));

describe("the editor's link parser", () => {
  for (const c of cases) {
    it(c.name, () => {
      const got = parseLinks(c.input).map((l) => ({ raw: c.input.slice(l.from, l.to), label: l.label, id: l.id, embed: l.embed }));
      expect(got).toEqual(c.links);
    });
  }

  it("formats links that parse back", () => {
    const id = "0192f3a4-7c1e-7b2a-9f00-3e5d8c1a2b44";
    for (const label of ["plain", "a|b", "[x]", "back\\slash"]) {
      const l = parseLinks(formatLink(label, id))[0]!;
      expect([l.label, l.id]).toEqual([label, id]);
    }
  });
});
