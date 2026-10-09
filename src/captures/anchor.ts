/**
 * Anchors: where a capture points, in the W3C Web Annotation model (FORMAT.md › Anchors).
 *
 * A text part is a TextQuoteSelector (the exact text with up to 32 code points of context on
 * each side) and a TextPositionSelector in code points into the stored text, refined by a page
 * or an EPUB CFI. Finding a place again:
 *  1. the position, if the quote is still there;
 *  2. otherwise the exact quote (whitespace may differ), chosen by its context;
 *  3. otherwise a fuzzy match (as Hypothesis does, with approx-string-match).
 * A fuzzy match above the threshold is "moved" until the user confirms it; below it the part
 * is "lost": listed, never drawn in the wrong place.
 *
 * Pure text work, without the DOM, so it can be tested alone.
 */
import search from "approx-string-match";

export const CONTEXT = 32;
/** A fuzzy match must score at least this (0–1) to be offered as "moved". */
export const MOVED_THRESHOLD = 0.75;

export const PDF_PAGE = "http://tools.ietf.org/rfc/rfc8118";
export const MEDIA = "http://www.w3.org/TR/media-frags/";
export const CFI = "http://www.idpf.org/epub/linking/cfi/epub-cfi.html";

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
  /** "page=3" (RFC 8118), "xywh=percent:10,20,30,40", or "epubcfi(…)". */
  value: string;
  conformsTo: string;
  refinedBy?: FragmentSelector;
}

export type Selector = TextQuoteSelector | TextPositionSelector | FragmentSelector;

export interface AnchorPart {
  selector: Selector[];
  boxes?: { page?: number; x: number; y: number; w: number; h: number }[];
  /** A region's picture beside the capture: ".region-<N>.png". */
  region?: string;
}

/** A capture's anchor, as `captures/<id>.anchor.json` holds it. */
export interface Anchor {
  id: string;
  source: string;
  snapshot: string | null;
  /** The stored text the positions refer to, with its extractor's version. */
  text: { file: string; extractor: string; version: number; snapshot?: string } | null;
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

// ---- Code points --------------------------------------------------------------------------

export function utf16ToCp(text: string, utf16: number): number {
  let cp = 0;
  for (let i = 0; i < utf16 && i < text.length; cp++) i += text.codePointAt(i)! > 0xffff ? 2 : 1;
  return cp;
}

export function sliceCp(text: string, start: number, end: number): string {
  return [...text].slice(start, end).join("");
}

// ---- Building -----------------------------------------------------------------------------

/** Selectors for the code-point range [start, end) of `text`. */
export function describe(text: string, start: number, end: number): [TextQuoteSelector, TextPositionSelector] {
  const cps = [...text];
  return [
    { type: "TextQuoteSelector", exact: cps.slice(start, end).join(""), prefix: cps.slice(Math.max(0, start - CONTEXT), start).join(""), suffix: cps.slice(end, end + CONTEXT).join("") },
    { type: "TextPositionSelector", start, end },
  ];
}

/** Finds a selection's text (as the reader shows it) in the stored text, within a segment if given. */
export function locateSelection(stored: string, selected: string, hint?: { from: number; to: number }): { start: number; end: number } | null {
  const exact = selected.trim();
  if (!exact) return null;
  const within = hint ? sliceCp(stored, hint.from, hint.to) : stored;
  const r = locate(within, [{ type: "TextQuoteSelector", exact, prefix: "", suffix: "" }]);
  if (r.status === "lost" || r.start === undefined) return null;
  const base = hint?.from ?? 0;
  return { start: base + r.start, end: base + r.end! };
}

/**
 * A quotation as it reads, not as it was laid out: line breaks inside a paragraph become spaces,
 * a word hyphenated across a line is joined ("suf-" + "fering"; a hyphen before a capital stays),
 * a dash at a line's end joins without a space, and paragraph breaks stay. The exact quote that
 * anchors a part keeps the source's text unchanged; this is for showing and storing.
 */
export function flowQuote(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .split(/\n[ \t]*\n+/)
    .map((para) =>
      para
        .replace(/(\p{L})[-­]\n[ \t]*(\p{Ll})/gu, "$1$2")
        .replace(/(\p{L})-\n[ \t]*(\p{Lu})/gu, "$1-$2")
        .replace(/([—–])[ \t]*\n[ \t]*/g, "$1")
        .replace(/[ \t]*\n[ \t]*/g, " ")
        .replace(/[ \t]{2,}/g, " ")
        .trim(),
    )
    .filter(Boolean)
    .join("\n\n");
}

// ---- Finding again ------------------------------------------------------------------------

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

const collapse = (s: string) => s.replace(/\s+/gu, " ").trim();

function allIndexes(hay: string, needle: string): number[] {
  const out: number[] = [];
  for (let i = needle ? hay.indexOf(needle) : -1; i >= 0; i = hay.indexOf(needle, i + 1)) out.push(i);
  return out;
}

function matchScore(text: string, str: string): number {
  if (!str.length || !text.length) return 0;
  const m = search(text, str, str.length);
  return m.length ? 1 - m[0]!.errors / str.length : 0;
}

/** Locates a part in `text`. */
export function locate(text: string, selectors: Selector[]): Located {
  const quote = selectors.find((s): s is TextQuoteSelector => s.type === "TextQuoteSelector");
  const pos = selectors.find((s): s is TextPositionSelector => s.type === "TextPositionSelector");
  if (!quote?.exact) return { status: "lost" };

  // 1. The position, if the quote is still there.
  if (pos && sliceCp(text, pos.start, pos.end) === quote.exact) return { status: "found", start: pos.start, end: pos.end, score: 1 };

  const n = normalized(text);
  const nq = collapse(quote.exact);
  const pre = collapse(quote.prefix);
  const suf = collapse(quote.suffix);
  // Offsets in n.text (UTF-16) back to code points of the original text.
  const toCp = (from: number, to: number) => ({ start: n.map[utf16ToCp(n.text, from)]!, end: n.map[utf16ToCp(n.text, to) - 1]! + 1 });

  // 2. The exact quote (whitespace may differ, e.g. after a reflow), chosen by its context.
  const hits = allIndexes(n.text, nq);
  if (hits.length) {
    const scored = hits.map((at) => {
      const before = n.text.slice(Math.max(0, at - CONTEXT * 2), at).trimEnd();
      const after = n.text.slice(at + nq.length, at + nq.length + CONTEXT * 2).trimStart();
      const ctx = (pre && before.endsWith(pre.slice(-Math.min(pre.length, 24))) ? 1 : 0) + (suf && after.startsWith(suf.slice(0, Math.min(suf.length, 24))) ? 1 : 0);
      const r = toCp(at, at + nq.length);
      return { ...r, ctx, dist: pos ? Math.abs(r.start - pos.start) : 0 };
    });
    scored.sort((a, b) => b.ctx - a.ctx || a.dist - b.dist);
    const best = scored[0]!;
    // One occurrence, or the only one whose context matches: this is the place.
    if (hits.length === 1 || (best.ctx > 0 && (scored[1]?.ctx ?? -1) < best.ctx)) return { status: "found", start: best.start, end: best.end, score: 1 };
    // Several equal candidates: the nearest, unconfirmed.
    return { status: "moved", start: best.start, end: best.end, score: 0.9 };
  }

  // 3. A fuzzy match, scored on the quote, its context and its position.
  const matches = search(n.text, nq, Math.min(256, Math.floor(nq.length / 2)));
  if (!matches.length) return { status: "lost" };
  const hint = pos ? n.map.findIndex((cp) => cp >= pos.start) : -1;
  const scoreOf = (m: { start: number; end: number; errors: number }) => {
    const quoteScore = 1 - m.errors / nq.length;
    const prefixScore = pre ? matchScore(n.text.slice(Math.max(0, m.start - pre.length - 1), m.start), pre) : 1;
    const suffixScore = suf ? matchScore(n.text.slice(m.end, m.end + suf.length + 1), suf) : 1;
    const posScore = hint >= 0 ? 1 - Math.abs(m.start - hint) / Math.max(1, n.text.length) : 1;
    return (50 * quoteScore + 20 * prefixScore + 20 * suffixScore + 2 * posScore) / 92;
  };
  const best = matches.map((m) => ({ m, score: scoreOf(m) })).sort((a, b) => b.score - a.score)[0]!;
  // The quote itself must still mostly be there.
  if (best.score < MOVED_THRESHOLD || 1 - best.m.errors / nq.length < 0.7) return { status: "lost", score: best.score };
  return { status: "moved", ...toCp(best.m.start, best.m.end), score: best.score };
}

/** One standard W3C annotation per part (for export). */
export function toW3C(a: Pick<Anchor, "id" | "parts">, body: string, sourceUri: string, created: string): object[] {
  return a.parts.map((p, i) => ({
    "@context": "http://www.w3.org/ns/anno.jsonld",
    id: `urn:uuid:${a.id}#${i + 1}`,
    type: "Annotation",
    created,
    body: body ? { type: "TextualBody", value: body, format: "text/markdown" } : undefined,
    target: { source: sourceUri, selector: p.selector.length === 1 ? p.selector[0] : p.selector },
  }));
}
