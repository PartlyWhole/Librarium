/**
 * Captures made in one step from the app's own data (a Bible passage, a word's origins), not in
 * the reader. The capture holds the words and a reference to their place (a FragmentSelector
 * that a part is found by), and cites a library item standing for the data, made the first
 * time. A selection in such a view gets Capture beside it.
 */
import { call } from "../backend";
import { listRecords, openRecord, putRecord } from "../app/records";
import { errorText, h, replace } from "../ui/dom";
import { icon } from "../ui/icon";
import { toast } from "../ui/toast";
import type { RecordInfo, Written } from "../types";
import { Highlighter } from "lucide";

/** The library item standing for some data: the one there is (`is`), or one made by `method`. */
export async function dataItem(is: (r: RecordInfo) => boolean, method: string, params: Record<string, unknown> = {}): Promise<RecordInfo> {
  const there = listRecords("item").find(is);
  if (there) return there;
  const w = await call<Written>(method, params);
  putRecord(w.info);
  return w.info;
}

/** Captures `quote` from `source`'s place `ref`, cited by `locator`; `label` says what it was. */
export async function captureReference(o: { source: () => Promise<RecordInfo>; quote: string; ref: { value: string; conformsTo: string }; locator: string; label: string }): Promise<void> {
  try {
    const source = await o.source();
    const w = await call<Written>("captures.create", {
      source: source.id, snapshot: null, text: null, words: "", title: null,
      parts: [{ selector: [{ type: "TextQuoteSelector", exact: o.quote, prefix: "", suffix: "" }, { type: "FragmentSelector", value: o.ref.value, conformsTo: o.ref.conformsTo }], quote: o.quote, locator: o.locator, region_png: null, boxes: [] }],
    });
    putRecord(w.info);
    toast(`Captured ${o.label}.`, { action: { label: "Open", run: () => openRecord(w.info.id) } });
  } catch (e) {
    toast(errorText(e));
  }
}

/** The words of a selection, as read: without what `leave` matches (numbers, other columns). */
export function selectedWords(range: Range, leave: string): string {
  const copy = h("div", null, range.cloneContents());
  if (leave) copy.querySelectorAll(leave).forEach((x) => x.remove());
  return (copy.textContent ?? "").replace(/\s+/g, " ").trim();
}

/**
 * Capture beside a selection made in `host`, when `passage` makes something of it (else
 * nothing shows); `capture` takes it. Returns how to stop.
 */
export function captureSelections<P>(host: HTMLElement, passage: (range: Range) => P | null, capture: (p: P) => void): () => void {
  const pop = h("div", { class: "selection-pop", role: "toolbar", "aria-label": "Selection", hidden: true });
  document.body.appendChild(pop);
  const onUp = () => setTimeout(() => {
    const sel = window.getSelection();
    const range = sel && !sel.isCollapsed && sel.rangeCount ? sel.getRangeAt(0) : null;
    const p = range && host.contains(range.commonAncestorContainer) ? passage(range) : null;
    if (!range || !p) return void (pop.hidden = true);
    replace(pop, h("button", { type: "button", onmousedown: (e: Event) => e.preventDefault(), onclick: () => ((pop.hidden = true), capture(p), window.getSelection()?.removeAllRanges()) }, icon(Highlighter, 14), "Capture"));
    pop.hidden = false;
    const rects = range.getClientRects();
    const end = rects[rects.length - 1] ?? range.getBoundingClientRect();
    Object.assign(pop.style, { left: `${Math.min(window.innerWidth - 120, end.right)}px`, top: `${Math.min(window.innerHeight - 40, end.bottom + 8)}px` });
  }, 0);
  const hide = () => (pop.hidden = true);
  host.addEventListener("mouseup", onUp);
  document.addEventListener("scroll", hide, true);
  return () => {
    host.removeEventListener("mouseup", onUp);
    document.removeEventListener("scroll", hide, true);
    pop.remove();
  };
}
