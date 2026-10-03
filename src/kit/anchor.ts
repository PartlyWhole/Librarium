/**
 * Anchors: where a capture points (§5.5), in the W3C Web Annotation model.
 *
 * A part is a TextQuoteSelector (the exact text plus about 32 characters of context on each
 * side) with a TextPositionSelector hint in Unicode code points, refined by a page, an image
 * region or an EPUB CFI. Positions refer to the stored extracted text.
 *
 * Finding a place again:
 *  1. try the position, and check the quote is there;
 *  2. otherwise search for the exact quote (whitespace may differ), using the context;
 *  3. otherwise fuzzy-match (Hypothesis's approach, with approx-string-match).
 * A fuzzy match above a set score is "moved" until the user confirms it; below it the anchor
 * is "lost": never deleted, never drawn in the wrong place.
 */
import search from "approx-string-match";

export const CONTEXT = 32;
/** A fuzzy match must score at least this (0–1) to be offered as "moved". */
export const MOVED_THRESHOLD = 0.75;

export interface TextQuoteSelector {
  type: "TextQuoteSelector";
  exact: string;
  prefix: string;
  suffix: string;
}

export interface TextPositionSelector {
  type: "TextPositionSelector";
  /** Code points. */
  start: number;
  end: number;
}

export interface FragmentSelector {
  type: "FragmentSelector";
  /** RFC 8118 for PDFs ("page=3"), or a media fragment ("xywh=percent:10,20,30,40"). */
  value: string;
  conformsTo: string;
  refinedBy?: FragmentSelector;
}

export interface CfiSelector {
  type: "FragmentSelector";
  value: string;
  conformsTo: "http://www.idpf.org/epub/linking/cfi/epub-cfi.html";
}

export type Selector = TextQuoteSelector | TextPositionSelector | FragmentSelector | CfiSelector;

export interface AnchorPart {
  selector: Selector[];
}

export interface Anchor {
  id: string;
  source: string;
  snapshot: string | null;
  /** The stored text the positions refer to, with its extractor's version. */
  text: { file: string; extractor: string; version: number } | null;
  parts: AnchorPart[];
}

export type Status = "found" | "moved" | "lost";

export interface Located {
  status: Status;
  /** Code-point range in the current text (absent when lost). */
  start?: number;
  end?: number;
  score?: number;
}

// ---- code points ↔ UTF-16 -------------------------------------------------------------------

/** UTF-16 index of each code point (plus the end). */
function cpIndex(text: string): number[] {
  const idx: number[] = [];
  let i = 0;
  for (const ch of text) {
    idx.push(i);
    i += ch.length;
  }
  idx.push(i);
  return idx;
}

export function utf16ToCp(text: string, utf16: number): number {
  let cp = 0;
  for (let i = 0; i < utf16 && i < text.length; ) {
    const c = text.codePointAt(i)!;
    i += c > 0xffff ? 2 : 1;
    cp++;
  }
  return cp;
}

export function cpToUtf16(text: string, cp: number): number {
  return cpIndex(text)[Math.min(cp, [...text].length)] ?? text.length;
}

export function sliceCp(text: string, start: number, end: number): string {
  return [...text].slice(start, end).join("");
}

// ---- building ------------------------------------------------------------------------------

/** Selectors for the code-point range [start, end) of `text`. */
export function describe(text: string, start: number, end: number): [TextQuoteSelector, TextPositionSelector] {
  const cps = [...text];
  return [
    { type: "TextQuoteSelector", exact: cps.slice(start, end).join(""), prefix: cps.slice(Math.max(0, start - CONTEXT), start).join(""), suffix: cps.slice(end, end + CONTEXT).join("") },
    { type: "TextPositionSelector", start, end },
  ];
}

/** Finds a selection's text (as the reader shows it) in the stored text, near a hint. */
export function locateSelection(stored: string, selected: string, hint?: { from: number; to: number }): { start: number; end: number } | null {
  const q = selected.trim();
  if (!q) return null;
  const quote: TextQuoteSelector = { type: "TextQuoteSelector", exact: q, prefix: "", suffix: "" };
  const within = hint ? sliceCp(stored, hint.from, hint.to) : stored;
  const base = hint?.from ?? 0;
  const r = locate(within, [quote]);
  if (r.status === "lost" || r.start === undefined) return null;
  return { start: base + r.start, end: base + r.end! };
}

// ---- finding again ---------------------------------------------------------------------------

/** Text with each whitespace run collapsed to one space, and a map back to code points. */
function normalized(text: string): { text: string; map: number[] } {
  const out: string[] = [];
  const map: number[] = [];
  let cp = 0;
  let space = false;
  for (const ch of text) {
    if (/\s/u.test(ch)) {
      if (!space && out.length) {
        out.push(" ");
        map.push(cp);
      }
      space = true;
    } else {
      out.push(ch);
      map.push(cp);
      space = false;
    }
    cp++;
  }
  map.push(cp);
  return { text: out.join(""), map };
}

function collapse(s: string): string {
  return s.replace(/\s+/gu, " ").trim();
}

function allIndexes(hay: string, needle: string): number[] {
  const out: number[] = [];
  if (!needle) return out;
  for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + 1)) out.push(i);
  return out;
}

function textMatchScore(text: string, str: string): number {
  if (!str.length || !text.length) return 0;
  const m = search(text, str, str.length);
  return m.length ? 1 - m[0]!.errors / str.length : 0;
}

/** Locates a part in `text`. */
export function locate(text: string, selectors: Selector[]): Located {
  const quote = selectors.find((s): s is TextQuoteSelector => s.type === "TextQuoteSelector");
  const pos = selectors.find((s): s is TextPositionSelector => s.type === "TextPositionSelector");
  if (!quote || !quote.exact) return { status: "lost" };

  // 1. The position, if the quote is still there.
  if (pos && sliceCp(text, pos.start, pos.end) === quote.exact) return { status: "found", start: pos.start, end: pos.end, score: 1 };

  // 2. The exact quote (whitespace may differ, e.g. after a reflow), chosen by its context.
  const n = normalized(text);
  const nq = collapse(quote.exact);
  const hits = allIndexes(n.text, nq);
  const toCp = (utf16Start: number, utf16End: number) => {
    // n.text is built from whole code points; convert UTF-16 offsets in n.text to its code points.
    const s = utf16ToCp(n.text, utf16Start);
    const e = utf16ToCp(n.text, utf16End);
    return { start: n.map[s]!, end: n.map[e - 1]! + 1 };
  };
  if (hits.length) {
    const scored = hits.map((h) => {
      const before = n.text.slice(Math.max(0, h - CONTEXT * 2), h);
      const after = n.text.slice(h + nq.length, h + nq.length + CONTEXT * 2);
      const pre = collapse(quote.prefix);
      const suf = collapse(quote.suffix);
      const ctx = (pre ? (before.trimEnd().endsWith(pre.slice(-Math.min(pre.length, 24))) ? 1 : 0) : 0) + (suf ? (after.trimStart().startsWith(suf.slice(0, Math.min(suf.length, 24))) ? 1 : 0) : 0);
      const r = toCp(h, h + nq.length);
      const dist = pos ? Math.abs(r.start - pos.start) : 0;
      return { ...r, ctx, dist };
    });
    scored.sort((a, b) => b.ctx - a.ctx || a.dist - b.dist);
    const best = scored[0]!;
    // One occurrence, or the only one whose context matches: this is the place.
    const unique = hits.length === 1 || (best.ctx > 0 && (scored[1]?.ctx ?? -1) < best.ctx);
    if (unique) return { status: "found", start: best.start, end: best.end, score: 1 };
    // Several equal candidates: offer the nearest, unconfirmed.
    return { status: "moved", start: best.start, end: best.end, score: 0.9 };
  }

  // 3. A fuzzy match (Hypothesis's scoring: quote, context and position).
  const maxErrors = Math.min(256, Math.floor(nq.length / 2));
  const matches = search(n.text, nq, maxErrors);
  if (!matches.length) return { status: "lost" };
  const hint = pos ? n.map.findIndex((cp) => cp >= pos.start) : -1;
  const pre = collapse(quote.prefix);
  const suf = collapse(quote.suffix);
  const scoreOf = (m: { start: number; end: number; errors: number }) => {
    const quoteScore = 1 - m.errors / nq.length;
    const prefixScore = pre ? textMatchScore(n.text.slice(Math.max(0, m.start - pre.length - 1), m.start), pre) : 1;
    const suffixScore = suf ? textMatchScore(n.text.slice(m.end, m.end + suf.length + 1), suf) : 1;
    const posScore = hint >= 0 ? 1 - Math.abs(m.start - hint) / Math.max(1, n.text.length) : 1;
    return (50 * quoteScore + 20 * prefixScore + 20 * suffixScore + 2 * posScore) / 92;
  };
  const best = matches.map((m) => ({ m, score: scoreOf(m) })).sort((a, b) => b.score - a.score)[0]!;
  // The quote itself must still mostly be there.
  if (best.score < MOVED_THRESHOLD || 1 - best.m.errors / nq.length < 0.7) return { status: "lost", score: best.score };
  return { status: "moved", ...toCp(best.m.start, best.m.end), score: best.score };
}

/** One standard W3C annotation per part (for export). */
export function toW3C(a: Anchor, body: string, sourceUri: string, created: string): object[] {
  return a.parts.map((p, i) => ({
    "@context": "http://www.w3.org/ns/anno.jsonld",
    id: `urn:uuid:${a.id}#${i + 1}`,
    type: "Annotation",
    created,
    body: body ? { type: "TextualBody", value: body, format: "text/markdown" } : undefined,
    target: { source: sourceUri, selector: p.selector.length === 1 ? p.selector[0] : p.selector },
  }));
}
