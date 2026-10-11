/**
 * A list of captures (and library items) to put somewhere: beside a board's drawing, or beside a
 * note. Each tab is a list, newest first, searched by one box. A source with several captures
 * is one group, closed until opened; while searching, groups with matches are open until closed
 * for that search.
 *
 * Rows can be selected (a click; ⌘-click adds or removes one, ⇧-click a range). A row is dragged
 * where it goes (with the others selected, if it is one of them), or Add puts it there; the bar
 * above the list adds everything selected, and ⌘C copies it when the host says how.
 */
import { folderOf } from "../app/folders";
import { getRecord, kindName, listRecords, recordIcon } from "../app/records";
import { dragSource } from "../ui/dnd";
import { h, replace } from "../ui/dom";
import { icon, iconButton } from "../ui/icon";
import { effect, signal } from "../ui/signal";
import { toast } from "../ui/toast";
import type { RecordInfo } from "../types";
import { F, isPicture, KIND, matches, newestFirst, quoteOf, regionImage, searchWords, sourceOf } from "./common";
import { ChevronRight, Plus } from "lucide";

export type Tab = "captures" | "library";

export interface PickerOptions {
  /** The tabs offered (all, by default). */
  tabs?: Tab[];
  /** Puts records where they go: on the board, into the note. */
  add(ids: string[]): void;
  /** The verb: "Add" (to the board), "Insert" (into the note). */
  verb: string;
  /** Where to, said in full: "Add to the board", "Insert into the note". */
  addLabel: string;
  /** Where to drag: "the board", "the note". */
  where: string;
  /** What ⌘C copies for these records, if anything. */
  copyText?(ids: string[]): string;
}

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
        : h("blockquote", { class: "picker-quote" }, quoteOf(c)),
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
    body: (r) => h("div", { class: "picker-title" }, icon(recordIcon(r), 15), h("span", null, r.title || "Untitled")),
    meta: (r) => [kindName(r), folderOf(r)].filter(Boolean).join(" · "),
  },
};

/** Draws the picker into `host`. Returns how to stop. */
export function renderPicker(host: HTMLElement, o: PickerOptions): () => void {
  const tabsShown = o.tabs ?? (Object.keys(LISTS) as Tab[]);
  const tabOf = () => (tabsShown.includes(lastTab()) ? lastTab() : tabsShown[0]!);
  const query = signal("");
  /** Groups closed during the current search. */
  const shut = signal<ReadonlySet<string>>(new Set());
  const search = h("input", { class: "search-input", type: "search", spellcheck: false });
  let timer: ReturnType<typeof setTimeout> | undefined;
  search.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(() => (query.set(search.value), shut.set(new Set())), 120);
  });
  const tabs = tabsShown.length > 1
    ? h("div", { class: "small-seg", role: "radiogroup", "aria-label": "Show" }, tabsShown.map((t) => h("button", { type: "button", role: "radio", dataset: { tab: t }, onclick: () => lastTab.set(t) }, LISTS[t].label)))
    : null;
  const hint = h("p", { class: "muted small picker-hint" }, `Drag onto ${o.where}, or click ${o.verb}. Select several with ⌘ or ⇧.`);
  const count = h("span", { class: "muted small" });
  // Its room is kept while nothing is chosen, so choosing doesn't move the rows under the pointer.
  const bar = h("div", { class: "picker-bar idle" }, count,
    h("button", { class: "button primary small", type: "button", onclick: () => (o.add(chosen()), pick([])) }, o.verb),
    h("button", { class: "button small", type: "button", onclick: () => pick([]) }, "Clear"));
  const list = h("div", { class: "picker-list", role: "listbox", "aria-multiselectable": "true", tabindex: "-1" });
  replace(host, h("div", { class: "picker-head" }, tabs, search, hint, bar), list);

  // ---- Choosing rows: kept in place (not drawn again), so focus and the pointer stay put ----
  let picked: string[] = [];
  let anchor: string | null = null;
  const rows = () => [...list.querySelectorAll<HTMLElement>(".picker-row")];
  /** What is chosen, in the list's order (inside a closed group too). */
  const chosen = () => rows().map((r) => r.dataset.id!).filter((id) => picked.includes(id));
  const pick = (ids: string[]) => {
    picked = ids;
    for (const r of list.querySelectorAll<HTMLElement>(".picker-row")) r.setAttribute("aria-selected", String(picked.includes(r.dataset.id!)));
    bar.classList.toggle("idle", !picked.length);
    for (const b of bar.querySelectorAll("button")) b.disabled = !picked.length;
    count.textContent = `${picked.length} selected`;
  };
  const click = (id: string, e: MouseEvent) => {
    if (e.metaKey) pick(picked.includes(id) ? picked.filter((x) => x !== id) : [...picked, id]);
    else if (e.shiftKey && anchor) {
      const order = rows().filter((r) => r.offsetParent).map((r) => r.dataset.id!);
      const [a, b] = [order.indexOf(anchor), order.indexOf(id)].sort((x, y) => x - y);
      if (a! >= 0) pick(order.slice(a, b! + 1));
    } else pick(picked.length === 1 && picked[0] === id ? [] : [id]);
    if (!e.shiftKey) anchor = id;
  };
  /** A row's records to act on: everything chosen, if it is one of them. */
  const withRow = (id: string) => (picked.includes(id) ? chosen() : [id]);

  const row = (r: RecordInfo, l: List, grouped = false): HTMLElement => {
    const meta = l.meta(r, grouped);
    const add = iconButton(Plus, o.addLabel, (e) => (e.stopPropagation(), o.add([r.id])), undefined, 15);
    add.classList.add("no-drag");
    const el = h("div", { class: "picker-row", role: "option", tabindex: "0", "aria-selected": String(picked.includes(r.id)), dataset: { id: r.id }, "aria-label": r.title || l.label },
      h("div", { class: "picker-body" }, l.body(r), meta ? h("div", { class: "muted small" }, meta) : null), add);
    el.addEventListener("click", (e) => click(r.id, e));
    el.addEventListener("keydown", (e) => {
      if (e.target !== el) return;
      if (e.key === "Enter") o.add(withRow(r.id));
      else if (e.key === " ") (e.preventDefault(), click(r.id, { metaKey: true, shiftKey: false } as MouseEvent));
    });
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
      list.querySelector<HTMLElement>(`.picker-group-head[data-source="${source}"]`)?.focus();
    };
    const items = h("div", { class: "picker-group-items", role: "group", hidden: !open }, rs.map((r) => row(r, l, true)));
    return h("div", { class: "picker-group" },
      h("button", { class: "picker-group-head", type: "button", "aria-expanded": String(open), dataset: { source }, onclick: toggle },
        icon(ChevronRight, 14), h("span", null, getRecord(source)?.title || "A source no longer in the library"), h("span", { class: "muted small" }, String(rs.length))),
      items);
  };

  const stopDrag = dragSource(list, (t) => {
    const id = t.closest<HTMLElement>(".picker-row")?.dataset.id;
    const ids = id ? withRow(id).filter((x) => getRecord(x)) : [];
    return ids.length ? { payload: { records: ids, folders: [], kind: getRecord(ids[0]!)!.kind }, label: getRecord(ids[0]!)!.title || "Untitled" } : null;
  });
  // ⌘C copies what is chosen (or the row with the focus), where the host says how.
  list.addEventListener("copy", (e) => {
    const focused = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>(".picker-row")?.dataset.id;
    const ids = picked.length ? chosen() : focused ? [focused] : [];
    if (!o.copyText || !ids.length || !e.clipboardData) return;
    e.preventDefault();
    e.clipboardData.setData("text/plain", o.copyText(ids));
    toast(`Copied ${ids.length === 1 ? "1 embed" : `${ids.length} embeds`}: paste into a note.`);
  });

  // Drawn again only when what it shows changes: records change often (this board saving), and
  // drawing again would take away focus and the row under the pointer.
  let drawn = "";
  const stop = effect(() => {
    const tab = tabOf();
    const l = LISTS[tab];
    for (const b of tabs?.querySelectorAll<HTMLElement>("button") ?? []) b.setAttribute("aria-checked", String(b.dataset.tab === tab));
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
    // What is chosen and no longer listed is let go.
    picked = picked.filter((id) => shown.some((r) => r.id === id));
    if (!all.length) replace(list, h("p", { class: "empty small" }, l.empty));
    else if (!shown.length) replace(list, h("p", { class: "empty small" }, l.none));
    else if (!l.group) replace(list, shown.map((r) => row(r, l)));
    else {
      // Groups in the order of their newest capture; a source with one capture is just its row.
      const groups = new Map<string, RecordInfo[]>();
      for (const r of shown) groups.set(l.group(r), [...(groups.get(l.group(r)) ?? []), r]);
      replace(list, [...groups].map(([source, rs]) => (rs.length === 1 ? row(rs[0]!, l) : group(source, rs, l, open(source)))));
    }
    pick(picked);
  });
  return () => {
    clearTimeout(timer);
    stopDrag();
    stop();
  };
}
