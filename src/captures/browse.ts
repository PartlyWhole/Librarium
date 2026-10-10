/**
 * The Captures page (⇧⌘K): every capture, searchable by quote, name, source or place; by source
 * or newest first; all, passages or pictures (both choices remembered). Cards show the quote or
 * a thumbnail, the name, source, place and date, with buttons on hover and a right-click menu.
 */
import type { PageContext } from "../app/pages";
import { pref } from "../app/prefs";
import { getRecord, listRecords, openRecord } from "../app/records";
import { h, replace } from "../ui/dom";
import { shortDate } from "../ui/format";
import { iconButton } from "../ui/icon";
import { effect, signal } from "../ui/signal";
import type { RecordInfo } from "../types";
import { copyEmbed, F, isPicture, KIND, matches, newestFirst, quoteOf, regionImage, searchWords, showInSource, sourceOf } from "./common";
import { captureMenu, deleteCapture } from "./delete";
import { Copy, LocateFixed, Pencil, Trash2 } from "lucide";

const group = pref<"source" | "newest">("captures.group", "source");
const show = pref<"all" | "passages" | "pictures">("captures.show", "all");

export function renderCaptures(host: HTMLElement, _params: Record<string, string>, ctx: PageContext): () => void {
  ctx.setTitle("Captures");
  const query = signal("");
  const search = h("input", { class: "search-input captures-search", type: "search", placeholder: "Search captures", "aria-label": "Search captures", spellcheck: false });
  let timer: ReturnType<typeof setTimeout> | undefined;
  search.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(() => query.set(search.value), 120);
  });
  const seg = <T extends string>(label: string, pref: { (): T; set(v: T): void }, options: [T, string][]) =>
    h("div", { class: "small-seg", role: "radiogroup", "aria-label": label }, options.map(([v, text]) => h("button", { type: "button", role: "radio", dataset: { value: v }, onclick: () => pref.set(v) }, text)));
  const groupSeg = seg("Arrange", group, [["source", "By source"], ["newest", "Newest first"]]);
  const showSeg = seg("Show", show, [["all", "All"], ["passages", "Passages"], ["pictures", "Pictures"]]);
  const count = h("span", { class: "muted small", role: "status" });
  const list = h("div");
  replace(host, h("div", { class: "captures-page" },
    h("div", { class: "captures-page-head" }, h("h1", { class: "page-title" }, "Captures"), count),
    h("div", { class: "captures-page-tools" }, search, groupSeg, showSeg),
    list));
  const thumbs = new Map<string, HTMLImageElement>();

  const card = (c: RecordInfo, withSource: boolean): HTMLElement => {
    const quote = quoteOf(c);
    // A name the user gave (not the quote's first words) is shown.
    const named = quote && !quote.startsWith(c.title.replace(/…$/, ""));
    const body = isPicture(c) ? (thumbs.get(c.id) ?? thumbs.set(c.id, regionImage(c.id, 1, "capture-thumb", c.title || "A captured picture")).get(c.id)!) : h("blockquote", { class: "capture-card-quote" }, quote);
    const meta = [named ? c.title : null, withSource ? getRecord(sourceOf(c))?.title : null, c.fields[F.locator] as string | undefined, c.created ? shortDate(c.created) : null].filter(Boolean).join(" · ");
    const el = h("article", { class: "capture-card", tabindex: "0", "aria-label": c.title || "Capture" },
      h("div", { class: "capture-card-body" }, body, h("div", { class: "muted small" }, meta)),
      h("div", { class: "capture-tools" },
        iconButton(LocateFixed, "Show in the source", () => showInSource(c), undefined, 15),
        iconButton(Pencil, "Edit selection", () => showInSource(c, { edit: true }), undefined, 15),
        iconButton(Copy, "Copy embed", () => copyEmbed(c), undefined, 15),
        iconButton(Trash2, "Delete", () => void deleteCapture(c), undefined, 15)));
    el.addEventListener("click", (e) => !(e.target as Element).closest("button") && openRecord(c.id, {}, { newTab: e.metaKey }));
    el.addEventListener("keydown", (e) => e.key === "Enter" && e.target === el && openRecord(c.id));
    el.addEventListener("contextmenu", (e) => (e.preventDefault(), captureMenu(c, { x: e.clientX, y: e.clientY })));
    return el;
  };

  const stop = effect(() => {
    const all = listRecords(KIND);
    const words = searchWords(query());
    const g = group();
    const s = show();
    for (const b of groupSeg.querySelectorAll<HTMLElement>("button")) b.setAttribute("aria-checked", String(b.dataset.value === g));
    for (const b of showSeg.querySelectorAll<HTMLElement>("button")) b.setAttribute("aria-checked", String(b.dataset.value === s));
    const shown = all
      .filter((c) => s === "all" || (s === "pictures") === isPicture(c))
      .filter((c) => matches(c, words))
      .sort(newestFirst);
    count.textContent = shown.length === all.length ? `${all.length} ${all.length === 1 ? "capture" : "captures"}` : `${shown.length} of ${all.length}`;
    if (!all.length) return replace(list, h("p", { class: "empty" }, "No captures yet. In a book, article or PDF, select a passage (or drag a region) and choose Capture."));
    if (!shown.length) return replace(list, h("p", { class: "empty" }, "No captures match."));
    if (g === "newest") return replace(list, h("div", { class: "capture-cards" }, shown.map((c) => card(c, true))));
    // By source: the source with the latest capture first; each source's captures in order.
    const bySource = new Map<string, RecordInfo[]>();
    for (const c of shown) bySource.set(sourceOf(c), [...(bySource.get(sourceOf(c)) ?? []), c]);
    replace(list, [...bySource].map(([id, cs]) => {
      const src = getRecord(id);
      return h("section", { class: "capture-group", "aria-label": src?.title ?? "A source" },
        h("h2", { class: "capture-group-head" },
          h("a", { href: "#", class: "list-link", onclick: (e: MouseEvent) => (e.preventDefault(), src && openRecord(id, {}, { newTab: e.metaKey })) }, src?.title ?? "A source no longer in the library"),
          h("span", { class: "muted small" }, ` ${cs.length}`)),
        h("div", { class: "capture-cards" }, cs.reverse().map((c) => card(c, false))));
    }));
  });
  search.focus();
  return () => {
    clearTimeout(timer);
    stop();
  };
}
