/**
 * Every capture is found again or listed as lost, never drawn in the wrong place, against a
 * fixture set of edits: insertions before, after and inside a paragraph, reflowing, deleting,
 * rewording and duplicating text.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe as select, locate, sliceCp, utf16ToCp, toW3C } from "./anchor";

interface Fixture {
  text: string;
  captures: { name: string; quote: string; occurrence?: number }[];
  edits: { name: string; find?: string; insert?: string; where?: "before" | "after"; reflow?: number; delete?: string; replace?: [string, string]; duplicate?: boolean }[];
}

const fx: Fixture = JSON.parse(readFileSync(path.resolve(import.meta.dirname, "anchors.json"), "utf8"));

/** Code-point range of the n-th occurrence of `q`. */
function rangeOf(text: string, q: string, occurrence = 1): [number, number] {
  let i = -1;
  for (let k = 0; k < occurrence; k++) i = text.indexOf(q, i + 1);
  if (i < 0) throw new Error(`no ${q}`);
  const s = utf16ToCp(text, i);
  return [s, s + [...q].length];
}

/** Applies an edit, tracking where each original code point goes (null when deleted). */
function apply(text: string, e: Fixture["edits"][number]): { text: string; map: (cp: number) => number | null } {
  const cps = [...text];
  if (e.find !== undefined && e.insert !== undefined) {
    let at = utf16ToCp(text, text.indexOf(e.find));
    if (e.where === "after") at += [...e.find].length;
    const n = [...e.insert].length;
    return { text: [...cps.slice(0, at), ...e.insert, ...cps.slice(at)].join(""), map: (cp) => (cp < at ? cp : cp + n) };
  }
  if (e.reflow) {
    // Re-wrap each paragraph at `reflow` columns: only whitespace changes.
    const out: string[] = [];
    const map: number[] = [];
    let col = 0;
    for (let i = 0; i < cps.length; i++) {
      const c = cps[i]!;
      const para = c === "\n" && (cps[i + 1] === "\n" || cps[i - 1] === "\n");
      if (c === " " && col >= e.reflow) {
        map.push(out.length);
        out.push("\n");
        col = 0;
      } else {
        map.push(out.length);
        out.push(para ? "\n" : c === "\n" ? " " : c);
        col = c === "\n" ? 0 : col + 1;
      }
    }
    return { text: out.join(""), map: (cp) => map[cp] ?? out.length };
  }
  if (e.delete) {
    const [s, en] = rangeOf(text, e.delete);
    return { text: [...cps.slice(0, s), ...cps.slice(en)].join(""), map: (cp) => (cp < s ? cp : cp >= en ? cp - (en - s) : null) };
  }
  if (e.replace) {
    const [s, en] = rangeOf(text, e.replace[0]);
    const n = [...e.replace[1]].length;
    // Text inside the replaced range maps (proportionally) into its replacement.
    return { text: [...cps.slice(0, s), ...e.replace[1], ...cps.slice(en)].join(""), map: (cp) => (cp < s ? cp : cp >= en ? cp - (en - s) + n : s + Math.floor(((cp - s) * n) / (en - s))) };
  }
  if (e.duplicate) return { text: text + "\n" + text, map: (cp) => cp };
  throw new Error("unknown edit");
}

describe("re-anchoring", () => {
  it("finds every capture in the unchanged text at its exact place", () => {
    for (const c of fx.captures) {
      const [s, e] = rangeOf(fx.text, c.quote, c.occurrence);
      const r = locate(fx.text, select(fx.text, s, e));
      expect([r.status, r.start, r.end], c.name).toEqual(["found", s, e]);
    }
  });

  for (const edit of fx.edits) {
    it(`after: ${edit.name}`, () => {
      const { text, map } = apply(fx.text, edit);
      const summary: string[] = [];
      for (const c of fx.captures) {
        const [s, e] = rangeOf(fx.text, c.quote, c.occurrence);
        const sel = select(fx.text, s, e);
        const r = locate(text, sel);
        const ms = map(s);
        const me = map(e - 1);
        const expected: [number, number] | null = ms === null || me === null ? null : [ms, me + 1];
        summary.push(`${c.name}: ${r.status}`);
        if (r.status === "lost") continue;
        // Never in the wrong place: a found or moved anchor overlaps where the text went.
        expect(expected, `${c.name} was deleted, yet ${r.status}`).not.toBeNull();
        const [xs, xe] = expected!;
        const overlap = Math.min(xe, r.end!) - Math.max(xs, r.start!);
        expect(overlap, `${c.name}: ${r.status} at ${r.start}-${r.end}, expected ${xs}-${xe}: “${sliceCp(text, r.start!, r.end!)}”`).toBeGreaterThan(0.5 * (xe - xs));
        if (r.status === "found") {
          // Found means the quote is exactly there (whitespace aside).
          expect(sliceCp(text, r.start!, r.end!).replace(/\s+/g, " "), c.name).toBe(c.quote.replace(/\s+/g, " "));
        }
      }
      // Each edit should still find most captures.
      expect(summary.filter((x) => !x.endsWith("lost")).length, summary.join("; ")).toBeGreaterThanOrEqual(fx.captures.length - 2);
    });
  }

  it("a reworded quote is offered as moved, a rewritten one is lost", () => {
    const [s, e] = rangeOf(fx.text, "Grace is the law of the descending movement.");
    const sel = select(fx.text, s, e);
    const reworded = fx.text.replace("the law of", "the law for");
    expect(locate(reworded, sel).status).toBe("moved");
    const gone = fx.text.replace("Grace is the law of the descending movement.", "Something else is said here, with nothing in common.");
    expect(locate(gone, sel).status).toBe("lost");
  });

  it("exports one W3C annotation per part", () => {
    const [s, e] = rangeOf(fx.text, "It avoids shock");
    const a = { id: "0192f3a4-7c1e-7b2a-9f00-0000000000c1", parts: [{ selector: [...select(fx.text, s, e), { type: "FragmentSelector" as const, value: "page=1", conformsTo: "http://tools.ietf.org/rfc/rfc8118" }] }, { selector: select(fx.text, 0, 9) }] };
    const w = toW3C(a, "my words", "urn:uuid:x", "2026-10-02T09:14:00Z") as { type: string; target: { selector: unknown[] } }[];
    expect(w).toHaveLength(2);
    expect(w[0]!.type).toBe("Annotation");
    expect(w[0]!.target.selector).toHaveLength(3);
  });
});
