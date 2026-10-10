/**
 * The Captures panel beside a board's drawing: every capture, newest first, searchable by quote,
 * name, source or place. A capture is dragged onto the drawing, or Add (or Enter) puts it in the
 * middle of the view. Either way it becomes the same card as Put on the board makes.
 */
import { getRecord, listRecords } from "../app/records";
import { dragSource } from "../ui/dnd";
import { h, replace } from "../ui/dom";
import { iconButton } from "../ui/icon";
import { effect, signal } from "../ui/signal";
import type { RecordInfo } from "../types";
import { F, isPicture, KIND, matches, newestFirst, quoteOf, regionImage, searchWords, sourceOf } from "../captures/common";
import { Plus } from "lucide";

/** Draws the panel into `host`; `add` puts a capture on the board. Returns how to stop. */
export function renderCapturePanel(host: HTMLElement, add: (id: string) => void): () => void {
  const query = signal("");
  const search = h("input", { class: "search-input", type: "search", placeholder: "Search captures", "aria-label": "Search captures", spellcheck: false });
  let timer: ReturnType<typeof setTimeout> | undefined;
  search.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(() => query.set(search.value), 120);
  });
  const hint = h("p", { class: "muted small board-captures-hint" }, "Drag one onto the board, or click Add.");
  const list = h("div", { class: "board-captures", role: "list", "aria-label": "Captures" });
  replace(host, h("div", { class: "board-captures-head" }, search, hint), list);
  const thumbs = new Map<string, HTMLImageElement>();

  const row = (c: RecordInfo): HTMLElement => {
    const body = isPicture(c)
      ? (thumbs.get(c.id) ?? thumbs.set(c.id, regionImage(c.id, 1, "capture-thumb", c.title || "A captured picture")).get(c.id)!)
      : h("blockquote", { class: "board-capture-quote" }, quoteOf(c));
    const meta = [getRecord(sourceOf(c))?.title, c.fields[F.locator] as string | undefined].filter(Boolean).join(" · ");
    const el = h("div", { class: "board-capture", role: "listitem", tabindex: "0", dataset: { id: c.id }, "aria-label": c.title || "Capture", title: "Drag onto the board" },
      h("div", { class: "board-capture-body" }, body, meta ? h("div", { class: "muted small" }, meta) : null),
      iconButton(Plus, "Add to the board", () => add(c.id), undefined, 15));
    el.querySelector("button")!.classList.add("no-drag");
    el.addEventListener("keydown", (e) => e.key === "Enter" && e.target === el && add(c.id));
    return el;
  };

  const stopDrag = dragSource(list, (t) => {
    const id = t.closest<HTMLElement>(".board-capture")?.dataset.id;
    const c = id ? getRecord(id) : undefined;
    return c ? { payload: { records: [c.id], folders: [], kind: KIND }, label: c.title || "Capture" } : null;
  });

  // Drawn again only when what it shows changes: records change often (this board saving), and
  // drawing again would take away focus and the row under the pointer.
  let drawn = "";
  const stop = effect(() => {
    const all = listRecords(KIND);
    const words = searchWords(query());
    const shown = all.filter((c) => matches(c, words)).sort(newestFirst);
    const key = `${all.length}|${shown.map((c) => `${c.id}:${c.version}:${getRecord(sourceOf(c))?.title ?? ""}`).join(",")}`;
    if (key === drawn) return;
    drawn = key;
    if (!all.length) return replace(list, h("p", { class: "empty small" }, "No captures yet. In a book, article or PDF, select a passage and choose Capture."));
    if (!shown.length) return replace(list, h("p", { class: "empty small" }, "No captures match."));
    replace(list, shown.map(row));
  });
  return () => {
    clearTimeout(timer);
    stopDrag();
    stop();
  };
}
