/**
 * What every view of a capture needs: its fields, its citation, where its source opens, its
 * parts as one quotation, and finding each part again in the stored text.
 */
import { call } from "../backend";
import { getRecord, listRecords, openRecord, records } from "../app/records";
import { h } from "../ui/dom";
import { toast } from "../ui/toast";
import type { RecordInfo, StoredText } from "../types";
import { flowQuote, locate, type Anchor, type AnchorPart, type TextQuoteSelector } from "./anchor";

export const KIND = "capture";
export const F = { source: "captures.source", quote: "captures.quote", parts: "captures.parts", locator: "captures.locator" };

export const sourceOf = (c: RecordInfo | undefined): string => String(c?.fields[F.source] ?? "");
export const quoteOf = (c: RecordInfo): string => flowQuote(String(c.fields[F.quote] ?? ""));
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

/** A part as shown: its text (with anything to show after it), or a picture. */
export type ShownPart = { text: string; after?: Node | null } | { picture: HTMLElement };

/**
 * Parts as they read: each run of text parts one quotation, joined by an inline "[…]" (a
 * passage left out); a picture between them stands on its own.
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
    if (quote) quote.append(h("span", { class: "quote-gap", title: "A passage left out" }, " […] "));
    else out.push((quote = h("blockquote", { class: cls })));
    quote.append(p.text, p.after ?? "");
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
  return a.parts.map((p) => (isRegion(p) ? "region" : !stored ? "lost" : locate(stored.text, p.selector).status));
}

/** The worst of a capture's statuses, as a badge's word ("" when all is well). */
export const worst = (st: PartStatus[]): "lost" | "moved" | "" => (st.includes("lost") ? "lost" : st.includes("moved") ? "moved" : "");

export function badge(status: PartStatus | ""): HTMLElement | null {
  if (status === "moved") return h("span", { class: "badge moved" }, "moved — check it");
  if (status === "lost") return h("span", { class: "badge lost" }, "lost");
  return null;
}
