/**
 * The panel beside a board's drawing: Captures and Library, each a list, newest first, searched
 * by one box. A row is dragged onto the drawing, or Add (or Enter) puts it in the middle of the
 * view: a capture or a document as a card, a picture as itself, as Put on the board does. A
 * source with several captures is one group, closed until opened; while searching, groups with
 * matches are open until closed for that search.
 */
import { folderOf } from "../app/folders";
import { getRecord, kindName, listRecords, recordIcon } from "../app/records";
import { dragSource } from "../ui/dnd";
import { h, replace } from "../ui/dom";
import { icon, iconButton } from "../ui/icon";
import { effect, signal } from "../ui/signal";
import type { RecordInfo } from "../types";
import { F, isPicture, KIND, matches, newestFirst, quoteOf, regionImage, searchWords, sourceOf } from "../captures/common";
import { ChevronRight, Plus } from "lucide";

type Tab = "captures" | "library";

/** The tab last shown, and the capture groups opened (kept while the app runs). */
const lastTab = signal<Tab>("captures");
const opened = signal<ReadonlySet<string>>(new Set());

interface List {
  label: string;
  kind: string;
  empty: string;
  none: string;
  matches(r: RecordInfo, words: string[]): boolean;
  /** A row's contents, and the words beneath it (`grouped`: under a group that names the source). */
  body(r: RecordInfo): HTMLElement;
  meta(r: RecordInfo, grouped?: boolean): string;
  /** What groups the rows (a capture's source), if they are grouped. */
  group?(r: RecordInfo): string;
}

const thumbs = new Map<string, HTMLImageElement>();

const LISTS: Record<Tab, List> = {
  captures: {
    label: "Captures",
    kind: KIND,
    empty: "No captures yet. In a book, article or PDF, select a passage and choose Capture.",
    none: "No captures match.",
    matches,
    body: (c) =>
      isPicture(c)
        ? (thumbs.get(c.id) ?? thumbs.set(c.id, regionImage(c.id, 1, "capture-thumb", c.title || "A captured picture")).get(c.id)!)
        : h("blockquote", { class: "board-panel-quote" }, quoteOf(c)),
    meta: (c, grouped) => [grouped ? null : getRecord(sourceOf(c))?.title, c.fields[F.locator] as string | undefined].filter(Boolean).join(" · "),
    group: sourceOf,
  },
  library: {
    label: "Library",
    kind: "item",
    empty: "No library items yet. Add PDFs, images or EPUBs, or save web pages.",
    none: "No library items match.",
    matches: (r, words) => {
      const p = (r.fields.provenance ?? {}) as Record<string, unknown>;
      const hay = [r.title, kindName(r), folderOf(r), p.author, p.publication].filter((x) => typeof x === "string").join(" ").toLowerCase();
      return words.every((w) => hay.includes(w));
    },
    body: (r) => h("div", { class: "board-panel-title" }, icon(recordIcon(r), 15), h("span", null, r.title || "Untitled")),
    meta: (r) => [kindName(r), folderOf(r)].filter(Boolean).join(" · "),
  },
};

/** Draws the panel into `host`; `add` puts a record on the board. Returns how to stop. */
export function renderBoardPanel(host: HTMLElement, add: (id: string) => void): () => void {
  const query = signal("");
  /** Groups closed during the current search. */
  const shut = signal<ReadonlySet<string>>(new Set());
  const search = h("input", { class: "search-input", type: "search", spellcheck: false });
  let timer: ReturnType<typeof setTimeout> | undefined;
  search.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(() => (query.set(search.value), shut.set(new Set())), 120);
  });
  const tabs = h("div", { class: "small-seg", role: "radiogroup", "aria-label": "Show" },
    (Object.keys(LISTS) as Tab[]).map((t) => h("button", { type: "button", role: "radio", dataset: { tab: t }, onclick: () => lastTab.set(t) }, LISTS[t].label)));
  const hint = h("p", { class: "muted small board-panel-hint" }, "Drag one onto the board, or click Add.");
  const list = h("div", { class: "board-panel-list", role: "list" });
  replace(host, h("div", { class: "board-panel-head" }, tabs, search, hint), list);

  const row = (r: RecordInfo, l: List, grouped = false): HTMLElement => {
    const meta = l.meta(r, grouped);
    const el = h("div", { class: "board-panel-row", role: "listitem", tabindex: "0", dataset: { id: r.id }, "aria-label": r.title || l.label, title: "Drag onto the board" },
      h("div", { class: "board-panel-body" }, l.body(r), meta ? h("div", { class: "muted small" }, meta) : null),
      iconButton(Plus, "Add to the board", () => add(r.id), undefined, 15));
    el.querySelector("button")!.classList.add("no-drag");
    el.addEventListener("keydown", (e) => e.key === "Enter" && e.target === el && add(r.id));
    return el;
  };

  /** A source's captures under its name. Opening one is kept while the app runs; closing one
   * while searching lasts for that search. */
  const group = (source: string, rs: RecordInfo[], l: List, open: boolean): HTMLElement => {
    const toggle = () => {
      const which = searchWords(query.peek()).length ? shut : opened;
      const next = new Set(which.peek());
      if (next.has(source)) next.delete(source);
      else next.add(source);
      which.set(next);
      list.querySelector<HTMLElement>(`.board-panel-group-head[data-source="${source}"]`)?.focus();
    };
    const items = h("div", { class: "board-panel-group-items", role: "group", hidden: !open }, rs.map((r) => row(r, l, true)));
    return h("div", { class: "board-panel-group", role: "listitem" },
      h("button", { class: "board-panel-group-head", type: "button", "aria-expanded": String(open), dataset: { source }, onclick: toggle },
        icon(ChevronRight, 14), h("span", null, getRecord(source)?.title || "A source no longer in the library"), h("span", { class: "muted small" }, String(rs.length))),
      items);
  };

  const stopDrag = dragSource(list, (t) => {
    const id = t.closest<HTMLElement>(".board-panel-row")?.dataset.id;
    const r = id ? getRecord(id) : undefined;
    return r ? { payload: { records: [r.id], folders: [], kind: r.kind }, label: r.title || "Untitled" } : null;
  });

  // Drawn again only when what it shows changes: records change often (this board saving), and
  // drawing again would take away focus and the row under the pointer.
  let drawn = "";
  const stop = effect(() => {
    const tab = lastTab();
    const l = LISTS[tab];
    for (const b of tabs.querySelectorAll<HTMLElement>("button")) b.setAttribute("aria-checked", String(b.dataset.tab === tab));
    search.placeholder = `Search ${l.label.toLowerCase()}`;
    search.setAttribute("aria-label", search.placeholder);
    list.setAttribute("aria-label", l.label);
    const all = listRecords(l.kind);
    const words = searchWords(query());
    const shown = all.filter((r) => l.matches(r, words)).sort(newestFirst);
    const open = (source: string) => (words.length ? !shut().has(source) : opened().has(source));
    const key = `${tab}|${all.length}|${words.length > 0}|${[...opened()].join()}|${[...shut()].join()}|${shown.map((r) => `${r.id}:${r.version}:${l.meta(r)}`).join(",")}`;
    if (key === drawn) return;
    drawn = key;
    if (!all.length) return replace(list, h("p", { class: "empty small" }, l.empty));
    if (!shown.length) return replace(list, h("p", { class: "empty small" }, l.none));
    if (!l.group) return replace(list, shown.map((r) => row(r, l)));
    // Groups in the order of their newest capture; a source with one capture is just its row.
    const groups = new Map<string, RecordInfo[]>();
    for (const r of shown) groups.set(l.group(r), [...(groups.get(l.group(r)) ?? []), r]);
    replace(list, [...groups].map(([source, rs]) => (rs.length === 1 ? row(rs[0]!, l) : group(source, rs, l, open(source)))));
  });
  return () => {
    clearTimeout(timer);
    stopDrag();
    stop();
  };
}
