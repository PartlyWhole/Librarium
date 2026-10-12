/**
 * What every view of a capture needs: its fields, its citation, where its source opens, its
 * parts as one quotation, and finding each part again in the stored text.
 */
import { call } from "../backend";
import { getRecord, listRecords, openRecord, records } from "../app/records";
import { h } from "../ui/dom";
import { toast } from "../ui/toast";
import type { RecordInfo, StoredText } from "../types";
import { symbolText } from "../reader/pdf/words";
import { flowQuote, locate, type Anchor, type AnchorPart, type TextQuoteSelector, BIBLE_REF } from "./anchor";

export const KIND = "capture";
export const F = { source: "captures.source", quote: "captures.quote", parts: "captures.parts", locator: "captures.locator" };

export const sourceOf = (c: RecordInfo | undefined): string => String(c?.fields[F.source] ?? "");
export const quoteOf = (c: RecordInfo): string => flowQuote(String(c.fields[F.quote] ?? ""));
/** Whether a capture's title is one the user gave (not the quote's first words, as made). */
export const isNamed = (c: RecordInfo): boolean => {
  const quote = quoteOf(c);
  return !quote || !quote.startsWith(c.title.replace(/…$/, ""));
};
/** What a capture is called in lists: its own name, else its whole quote (never cut short). */
export const shownName = (c: RecordInfo): string => (isNamed(c) ? c.title : quoteOf(c)) || "Capture";
/** A capture of a picture only (no quoted text). */
export const isPicture = (c: RecordInfo): boolean => !String(c.fields[F.quote] ?? "").trim();
const byCreated = (a: RecordInfo, b: RecordInfo) => (a.created ?? "").localeCompare(b.created ?? "");
export const newestFirst = (a: RecordInfo, b: RecordInfo) => byCreated(b, a);

/** Whether a capture's quote, name, source or place has every word of a search. */
export function matches(c: RecordInfo, words: string[]): boolean {
  const hay = [c.title, c.fields[F.quote], c.fields[F.locator], getRecord(sourceOf(c))?.title].filter(Boolean).join(" ").toLowerCase();
  return words.every((w) => hay.includes(w));
}

/** A search box's words, lower case. */
export const searchWords = (query: string): string[] => query.trim().toLowerCase().split(/\s+/).filter(Boolean);

/** Captures by source, worked out once for each version of the records. */
let bySource: { of: ReadonlyMap<string, RecordInfo>; map: Map<string, RecordInfo[]> } | null = null;

/** A source's captures (not archived), oldest first. */
export function capturesOf(source: string): RecordInfo[] {
  const all = records();
  if (bySource?.of !== all) {
    const map = new Map<string, RecordInfo[]>();
    for (const c of listRecords(KIND).sort(byCreated)) {
      const list = map.get(sourceOf(c));
      if (list) list.push(c);
      else map.set(sourceOf(c), [c]);
    }
    bySource = { of: all, map };
  }
  return bySource.map.get(source) ?? [];
}

/** "Source, place, place": places that only repeat the source's title are left out. */
export function cite(title: string, places: (string | null | undefined)[]): string {
  const same = (a: string) => a.trim().toLowerCase() === title.trim().toLowerCase();
  const kept = [...new Set(places.filter((l): l is string => !!l?.trim() && !same(l)))];
  return kept.length ? `${title}, ${kept.join(", ")}` : title;
}

export function citation(c: RecordInfo): string {
  return cite(getRecord(sourceOf(c))?.title ?? "an unknown source", [c.fields[F.locator] as string | undefined]);
}

export const anchorOf = (id: string): Promise<Anchor> => call<Anchor>("captures.anchor", { id });

/** A part's exact quote (empty for a region or picture). */
export const partQuote = (p: AnchorPart): string => (p.selector.find((s) => s.type === "TextQuoteSelector") as TextQuoteSelector | undefined)?.exact ?? "";

/** Whether a part is a region or a picture (it has no quote). */
export const isRegion = (p: AnchorPart): boolean => !!p.region || !partQuote(p);

/**
 * Where to open a capture's source: a part's place (its selectors, plus the boxes it was drawn
 * in, which take the reader straight there; they travel only in the route), in its snapshot.
 */
export function placeParams(a: Anchor | null, part = a?.parts[0]): Record<string, string> {
  const place = part ? JSON.stringify([...part.selector, ...(part.boxes?.length ? [{ type: "librarium:boxes", boxes: part.boxes }] : [])]) : "";
  return { ...(place ? { place } : {}), ...(a?.snapshot ? { snapshot: a.snapshot } : {}) };
}

/** Opens a capture's source at its place (or, with `edit`, to edit its parts there). */
export function showInSource(c: RecordInfo, o: { edit?: boolean; newTab?: boolean } = {}): void {
  const src = sourceOf(c);
  void anchorOf(c.id).then(
    (a) => openRecord(src, { ...placeParams(a), ...(o.edit ? { edit: c.id } : {}) }, { again: true, newTab: o.newTab }),
    () => openRecord(src, {}, { newTab: o.newTab }),
  );
}

export function copyEmbed(c: RecordInfo): void {
  void navigator.clipboard?.writeText(`![[${c.title}|${c.id}]]`).then(() => toast("Embed copied: paste it into a note."), () => toast("The embed couldn’t be copied."));
}

/** A character no font can be trusted to draw: private, replaced, or a control. */
const UNREADABLE = /[\uE000-\uF8FF\uFFFD\p{Cc}]/u;
/** A Greek letter or a mathematical sign (minus, ±, ×, ≤, ∞, primes…). */
const SYMBOL = /[\p{Script=Greek}\p{Sm}\u2032-\u2037\u00B0\u00B5]/u;

type QuotedPart = { text: string | null; continues?: boolean };

/** Parts' text joined as a capture's quote joins them, and where each one is in it. */
function joining(parts: QuotedPart[]): { joined: string; spans: ([number, number] | null)[] } {
  let joined = "";
  const spans = parts.map((p): [number, number] | null => {
    const t = p.text?.trim();
    if (!t) return null;
    if (joined) joined += p.continues ? " " : " […] ";
    const start = [...joined].length;
    joined += t;
    return [start, [...joined].length];
  });
  return { joined, spans };
}

export const joinParts = (parts: QuotedPart[]): string => joining(parts).joined;

/**
 * A quote from the stored text with its symbols as the page shows them. Some PDFs don't say
 * what their symbol glyphs are, and the stored text then has a box, a plain letter ("g" for "γ"),
 * a hyphen (for "−") or another code ("³" for "≥") where the reader's own text has the symbol.
 * The two are matched letter by letter, spaces aside, and only where they line up; then the
 * page's symbol is taken where the stored text has something unreadable, a plain letter, a
 * hyphen, or the symbol's code.
 */
export function symbolsFrom(stored: string, shown: string): string {
  const a = [...stored];
  const b = [...shown].filter((c) => !/\s/u.test(c));
  if (a.filter((c) => !/\s/u.test(c)).length !== b.length) return stored;
  let j = 0;
  return a
    .map((c) => {
      if (/\s/u.test(c)) return c;
      const p = b[j++]!;
      return p !== c && SYMBOL.test(p) && (UNREADABLE.test(c) || /[A-Za-z-]/.test(c) || symbolText(c) === p) ? p : c;
    })
    .join("");
}

/**
 * A quote saved before its symbols could be read, with them as `text` (a page's) has them. The
 * quote is found in the text letter by letter, spaces and line-end hyphens aside, a symbol there
 * standing for an unreadable character or for its code ("g" for "γ", "³" for "≥"). Unchanged
 * where it isn't found.
 */
export function symbolsIn(quote: string, text: string): string {
  const q = [...quote];
  const at = q.flatMap((c, i) => (/\s/u.test(c) ? [] : [i]));
  const t = [...text].filter((c) => !/\s/u.test(c));
  if (!at.length || t.join("").includes(at.map((i) => q[i]).join(""))) return quote;
  const like = (a: string, b: string) => a === b || (SYMBOL.test(b) && (UNREADABLE.test(a) || symbolText(a) === b));
  for (let s = 0; s < t.length; s++) {
    const took: string[] = [];
    for (let j = s; took.length < at.length && j < t.length; j++) {
      if (like(q[at[took.length]!]!, t[j]!)) took.push(t[j]!);
      else if (!took.length || !/[-­]/.test(t[j]!)) break;
    }
    if (took.length < at.length) continue;
    at.forEach((i, n) => SYMBOL.test(took[n]!) && (q[i] = took[n]!));
    return q.join("");
  }
  return quote;
}

/**
 * The text parts as the capture's quote has them (null for a picture). The anchor keeps the
 * stored text's characters, so a capture finds its place again; the quote has the symbols as
 * the page showed them. Every symbol stands in for one character, so the parts, joined as the
 * quote joins them, line up with it, and each part is cut back out.
 */
export function partsAsQuoted(quote: string, parts: QuotedPart[]): (string | null)[] {
  const { joined, spans } = joining(parts);
  const mended = [...symbolsFrom(joined, quote)];
  return parts.map((p, i) => (spans[i] ? mended.slice(spans[i]![0], spans[i]![1]).join("") : p.text));
}

/**
 * Whether a part runs on from the one before as one sentence (split by a page break or a
 * footnote): the first ends mid-sentence and the next starts in lower case.
 */
export const runsOn = (before: string, after: string): boolean =>
  !/[.!?…:;]["'”’)\]]*$/u.test(before.trim()) && /^["'“‘(]*\p{Ll}/u.test(after.trim());

/**
 * A part as shown: its text (with anything to show after it, and whether it continues the one
 * before, or what to show between them), or a picture.
 */
export type ShownPart = { text: string; after?: Node | null; joined?: boolean; gap?: Node; go?: (e: MouseEvent) => void } | { picture: HTMLElement };

/**
 * Parts as they read: each run of text parts one quotation, joined by an inline "[…]" (a
 * passage left out), or by a space where a part continues the sentence; a picture between them
 * stands on its own.
 */
export function quoteParts(parts: ShownPart[], cls: string): HTMLElement[] {
  const out: HTMLElement[] = [];
  let quote: HTMLElement | null = null;
  for (const p of parts) {
    if ("picture" in p) {
      quote = null;
      out.push(p.picture);
      continue;
    }
    if (quote) quote.append(p.gap ?? (p.joined ? " " : h("span", { class: "quote-gap", title: "A passage left out" }, " […] ")));
    else out.push((quote = h("blockquote", { class: cls })));
    // A part with somewhere to go is a link to it (its place in the source).
    const text = p.go ? h("a", { href: "#", class: "quote-part-link", title: "Show this part in the source", onclick: (e: MouseEvent) => (e.preventDefault(), p.go!(e)) }, p.text) : p.text;
    quote.append(text, p.after ?? "");
  }
  return out;
}

/** A region's picture, filled in when it has loaded. */
export function regionImage(id: string, n: number, cls = "capture-region", alt = "A captured picture"): HTMLImageElement {
  const img = h("img", { class: cls, alt });
  void call<string>("captures.region", { id, n }).then((d) => (img.src = d), () => (img.alt = `${alt} (can’t be shown)`));
  return img;
}

type PartStatus = "found" | "moved" | "lost" | "region";

/** The stored text a capture's places point into. */
export const storedText = (a: Anchor): Promise<StoredText | null> => call<StoredText | null>("records.text", { id: a.source, part: a.snapshot ?? null }).catch(() => null);

/** Finds every part of a capture again in its source's stored text (fetched by `text`). */
export async function statuses(a: Anchor, text = storedText): Promise<PartStatus[]> {
  const stored = await text(a);
  // A Bible passage is where its reference says (its version's text is the Bible's own).
  return a.parts.map((p) => (isRegion(p) ? "region" : p.selector.some((s) => "conformsTo" in s && s.conformsTo === BIBLE_REF) ? "found" : !stored ? "lost" : locate(stored.text, p.selector).status));
}

/** The worst of a capture's statuses, as a badge's word ("" when all is well). */
export const worst = (st: PartStatus[]): "lost" | "moved" | "" => (st.includes("lost") ? "lost" : st.includes("moved") ? "moved" : "");

export function badge(status: PartStatus | ""): HTMLElement | null {
  if (status === "moved") return h("span", { class: "badge moved" }, "moved — check it");
  if (status === "lost") return h("span", { class: "badge lost" }, "lost");
  return null;
}
