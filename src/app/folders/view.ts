/**
 * A space's page (Notes, Library): one folder's contents, as in Finder. A list (Name, Kind,
 * Added) or icons; folders first. A click selects (⌘-click and ⇧-click select several, a drag on
 * the background draws a box), a double-click or Return opens, ⌘↑ goes up. Things are dragged
 * onto folders, the path or the sidebar to move them, or between entries to arrange them; F2
 * renames; the context menu (or the menu key) offers the rest.
 */
import { h, isEditable, replace } from "../../ui/dom";
import { dragSource, dropTarget, zone, type DragPayload } from "../../ui/dnd";
import { count, shortDate } from "../../ui/format";
import { icon, iconButton } from "../../ui/icon";
import { contextMenu, isMenuKey, menuPointFor, type MenuItem, type Point } from "../../ui/menu";
import { Selection } from "../../ui/selectlist";
import { effect, signal, untracked } from "../../ui/signal";
import { toast } from "../../ui/toast";
import { actionList, runAction } from "../actions";
import { here as hereSignal, type PageContext } from "../pages";
import { kindName, openRecord, recordDetail, recordIcon } from "../records";
import { recordActionsFor } from "../recordmenu";
import { router } from "../router";
import { badFolderName, folderId, isFolderId, join, keyOf, nameOf, parentOf, pathOfId, uniqueName, type Entry, type SortKey } from "./model";
import { folderMenu, goFolder, manyMenu } from "./menus";
import { canMoveInto, canPlaceIn, moveInto, newFolder, place, renameFolder, renameRecord } from "./ops";
import { contents, sorted, type Space } from "./spaces";
import { ArrowDownUp, Folder, FolderPlus, LayoutGrid, List } from "lucide";
import "./folders.css";

/** The entry last focused in each folder, so going back up lands where one left. */
const lastFocus = new Map<string, string>();
/** An entry to select when a folder opens next ("Show in its folder"). */
let arrival: { folder: string; id: string } | null = null;
export function arriveWith(folder: string, id: string): void {
  arrival = { folder, id };
}

/** Each folder page's way to make a folder; the one in the tab shown answers New folder. */
const makers = new Map<HTMLElement, () => void>();
export function makeFolderHere(): boolean {
  const shown = [...makers].find(([host]) => host.isConnected && !host.closest("[hidden]"));
  shown?.[1]();
  return !!shown;
}

const SORTS: [SortKey, string][] = [["name", "Name"], ["kind", "Kind"], ["added", "Date added"], ["manual", "As arranged (drag to arrange)"]];

export function renderFolder(sp: Space, host: HTMLElement, params: Record<string, string>, ctx: PageContext): () => void {
  const here = params.folder ?? "";
  const { view, sort, kind } = sp;
  const spot = (folder: string) => `${sp.page}:${folder}`;
  const filterText = signal("");
  const selection = new Selection();
  let order: string[] = [];
  let entries = new Map<string, Entry>();
  let focused: string | null = lastFocus.get(spot(here)) ?? null;
  if (arrival?.folder === here) {
    selection.set([arrival.id], arrival.id);
    focused = arrival.id;
  }
  arrival = null;
  let renaming = false;
  let alive = true;
  hereSignal.set({ kind, folder: here });

  // ---- The frame ------------------------------------------------------------------------
  const crumbs = h("ol", { class: "crumbs" });
  const filter = h("input", { class: "files-filter", type: "search", placeholder: "Filter this folder", "aria-label": "Filter this folder", spellcheck: false });
  filter.addEventListener("input", () => filterText.set(filter.value));
  filter.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && filter.value) {
      e.stopPropagation();
      filter.value = "";
      filterText.set("");
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      focusEntry(focused ?? order[0]);
    }
  });
  const listButton = iconButton(List, "As a list", () => view.set("list"), undefined, 16);
  const iconsButton = iconButton(LayoutGrid, "As icons", () => view.set("icons"), undefined, 16);
  const bar = h("div", { class: "files-bar" },
    h("nav", { class: "files-crumbs", "aria-label": "Folder path" }, crumbs),
    h("span", { class: "spacer" }),
    filter,
    iconButton(ArrowDownUp, "Sort by", (e) => sortMenu(menuPointFor(e.currentTarget as Element)), undefined, 16),
    h("span", { class: "segmented", role: "group", "aria-label": "View" }, listButton, iconsButton));
  const head = h("div", { class: "files-head", role: "presentation" });
  const body = h("div", { class: "files-body", role: "listbox", "aria-multiselectable": "true", "aria-label": "Contents", tabindex: "-1" });
  const empty = h("div", { class: "files-empty" });
  // Below: how much is here, and what can be done with what is selected.
  const footText = h("span", { role: "status", "aria-live": "polite" });
  const footActions = h("span", { class: "files-actions", role: "toolbar", "aria-label": "Selected items" });
  replace(host, bar, head, body, empty, h("div", { class: "files-foot" }, footText, footActions));
  host.classList.add("files-page");
  const headerButtons = sp.header.filter(([id]) => actionList().some((a) => a.id === id)).map(([id, node, label]) => iconButton(node, label, () => runAction(id), actionList().find((a) => a.id === id)?.keys?.[0]));
  ctx.setHeaderActions([...headerButtons, iconButton(FolderPlus, "New folder", () => void makeFolder(), "Mod+Shift+N")]);

  const remember = () => focused && lastFocus.set(spot(here), focused);
  const goUp = () => {
    if (!here) return;
    remember();
    lastFocus.set(spot(parentOf(here)), folderId(here));
    goFolder(sp, parentOf(here));
  };
  const open = (e: Entry, newTab = false) => {
    remember();
    if (e.type === "folder") goFolder(sp, e.path, newTab);
    else openRecord(e.id, {}, { newTab });
  };
  const payload = (ids: string[]): DragPayload => ({ kind, records: ids.filter((i) => !isFolderId(i)), folders: ids.filter(isFolderId).map(pathOfId) });
  const dropInto = (el: HTMLElement, dest: string) => dropTarget(el, { accepts: (p) => canMoveInto(p, dest, sp), drop: (p) => void moveInto(sp, p, dest) });
  // Dropped on the background (or the note an empty folder shows): into this folder.
  dropInto(body, here);
  dropInto(empty, here);

  // ---- Painting -------------------------------------------------------------------------
  const options = () => [...body.querySelectorAll<HTMLElement>("[role=option]")];
  const elOf = (id: string | null | undefined) => options().find((x) => x.dataset.id === id);
  let counts = "";
  let footFor: string | null = null;
  const markSelection = () => {
    const s = selection.ids.peek();
    for (const el of options()) {
      const on = s.has(el.dataset.id!);
      el.setAttribute("aria-selected", String(on));
      el.classList.toggle("selected", on);
      el.tabIndex = el.dataset.id === focused ? 0 : -1;
    }
    const ids = selection.inOrder(order);
    footText.textContent = ids.length ? `${ids.length} selected · ${counts}` : counts;
    // The buttons are rebuilt only when the selection changes.
    if (ids.join(",") === footFor) return;
    footFor = ids.join(",");
    const items = ids.length ? menuItems(ids).filter((i) => i !== "separator") : [];
    replace(footActions, items.map((i) => h("button", { class: `button small${i.destructive ? " destructive" : ""}`, type: "button", onclick: () => i.run() }, i.label)));
  };
  const focusEntry = (id: string | undefined) => {
    if (!id) return;
    focused = id;
    markSelection();
    const el = elOf(id);
    el?.focus({ preventScroll: true });
    el?.scrollIntoView({ block: "nearest" });
  };

  const entryEl = (e: Entry) => {
    const detail = e.type === "record" ? recordDetail(e.record) : "";
    const big = view.peek() === "icons";
    const name = h("span", { class: "files-name" }, icon(e.type === "folder" ? Folder : recordIcon(e.record), big ? 40 : 16),
      h("span", { class: "files-name-lines" }, h("span", { class: "files-name-text" }, e.name), detail ? h("span", { class: "files-detail" }, detail) : null));
    const kindText = e.type === "record" ? kindName(e.record) : `Folder · ${e.count ? count(e.count, "item") : "empty"}`;
    const el = h("div", { role: "option", class: `files-entry ${e.type}`, tabindex: "-1", dataset: { id: e.id }, title: detail ? `${e.name}\n${detail}` : e.name },
      name,
      big ? null : [h("span", { class: "files-kind" }, kindText), h("span", { class: "files-added" }, e.type === "record" && e.record.created ? shortDate(e.record.created) : "")]);
    // Dropped on its edges, things go beside it (arranged by hand); in a folder's middle, into it.
    const into = (p: DragPayload) => e.type === "folder" && canMoveInto(p, e.path, sp);
    dropTarget(el, {
      accepts: (p) => into(p) || canPlaceIn(p, here, sp),
      where: (p, x, y, target) => {
        if (e.type === "folder" ? p.folders.includes(e.path) : p.records.includes(e.id)) return null;
        const w = zone(target, x, y, { horizontal: view.peek() === "icons", into: into(p) });
        return w === "into" || canPlaceIn(p, here, sp) ? w : null;
      },
      drop: (p, w) => void (w === "into" ? e.type === "folder" && moveInto(sp, p, e.path) : place(sp, here, p, keyOf(e), w)),
    });
    return el;
  };

  const paint = () => {
    // What is read here is what repaints it.
    const c = contents(sp);
    const v = view();
    const s = sort();
    const q = filterText().trim().toLowerCase();
    const all = sorted(sp, here);
    if (renaming) return;
    if (here && !c.has(here)) {
      // Moved or removed elsewhere: show the nearest folder still there.
      let up = parentOf(here);
      while (up && !c.has(up)) up = parentOf(up);
      queueMicrotask(() => alive && router.go(sp.page, up ? { folder: up } : {}, { replace: true }));
      return;
    }
    ctx.setTitle(here ? nameOf(here) : sp.title);
    untracked(() => {
      // The path, each part a place to go and to drop on.
      const parts = ["", ...here.split("/").map((_, i, a) => a.slice(0, i + 1).join("/"))].filter((p, i) => i === 0 || p);
      replace(crumbs, parts.map((p) => {
        const current = p === here;
        const b = h("button", { class: "crumb", type: "button", "aria-current": current ? "location" : undefined, onclick: () => !current && (remember(), goFolder(sp, p)) }, p ? nameOf(p) : sp.title);
        if (!current) dropInto(b, p);
        return h("li", null, b);
      }));
      listButton.setAttribute("aria-pressed", String(v === "list"));
      iconsButton.setAttribute("aria-pressed", String(v === "icons"));
      const shown = q ? all.filter((e) => e.name.toLowerCase().includes(q)) : all;
      entries = new Map(shown.map((e) => [e.id, e]));
      order = shown.map((e) => e.id);
      const kept = selection.inOrder(order);
      if (kept.length !== selection.ids.peek().size) selection.set(kept);
      if (!focused || !entries.has(focused)) focused = kept[0] ?? order[0] ?? null;
      const hadFocus = body.contains(document.activeElement);
      body.className = `files-body ${v}`;
      head.hidden = v !== "list" || !shown.length;
      const col = (key: SortKey, label: string) =>
        h("button", { class: `files-col ${key}`, type: "button", "aria-sort": s.key === key ? (s.dir === 1 ? "ascending" : "descending") : undefined, onclick: () => sort.set({ key, dir: s.key === key ? (-s.dir as 1 | -1) : 1 }) },
          label, s.key === key ? h("span", { class: "files-arrow", "aria-hidden": "true" }, s.dir === 1 ? "▲" : "▼") : null);
      replace(head, col("name", "Name"), col("kind", "Kind"), col("added", "Added"));
      replace(body, shown.map(entryEl));
      const folders = all.filter((e) => e.type === "folder").length;
      counts = [folders ? count(folders, "folder") : "", all.length - folders ? count(all.length - folders, "item") : ""].filter(Boolean).join(", ") || "Empty";
      empty.hidden = shown.length > 0;
      replace(empty, q
        ? h("p", null, "Nothing in this folder matches.")
        : h("div", null, h("p", null, here ? "This folder is empty." : sp.pageEmpty), h("p", { class: "muted small" }, "Drag things here, or make a folder (⇧⌘N). What you add while looking at a folder goes into it.")));
      footFor = null;
      markSelection();
      if (hadFocus || document.activeElement === document.body) elOf(focused)?.focus({ preventScroll: true });
    });
  };
  const stop = effect(paint);

  // ---- Renaming in place ----------------------------------------------------------------
  const rename = (id: string | null | undefined) => {
    const e = id ? entries.get(id) : undefined;
    const text = elOf(id)?.querySelector<HTMLElement>(".files-name-text");
    if (!e || !text) return;
    if (e.type === "record" && e.record.read_only) return toast("This item can’t be renamed: it’s read-only.");
    renaming = true;
    const input = h("input", { class: "files-rename", value: e.name, "aria-label": `New name for “${e.name}”`, spellcheck: false });
    text.replaceWith(input);
    input.focus();
    input.select();
    let finished = false;
    const finish = async (save: boolean) => {
      if (finished) return;
      finished = true;
      const name = input.value.trim();
      let now = e.id;
      if (save && name && name !== e.name) {
        if (e.type === "record") await renameRecord(e.id, name);
        else if (badFolderName(name)) toast(badFolderName(name)!);
        else {
          const to = await renameFolder(sp, e.path, name);
          if (to) now = folderId(to);
        }
      }
      renaming = false;
      if (!alive) return;
      if (now !== e.id) selection.set([now], now);
      focused = now;
      paint();
      focusEntry(now);
    };
    input.addEventListener("keydown", (k) => {
      k.stopPropagation();
      if (k.key !== "Enter" && k.key !== "Escape") return;
      k.preventDefault();
      void finish(k.key === "Enter");
    });
    input.addEventListener("blur", () => void finish(true));
    for (const ev of ["click", "dblclick", "mousedown", "pointerdown"]) input.addEventListener(ev, (x) => x.stopPropagation());
  };

  const makeFolder = async () => {
    const c = untracked(() => contents(sp));
    const path = await newFolder(sp, join(here, uniqueName("untitled folder", (n) => c.has(join(here, n)))));
    if (!path || !alive) return;
    filter.value = "";
    filterText.set("");
    focused = folderId(path);
    selection.set([focused], focused);
    paint();
    focusEntry(focused);
    rename(focused);
  };

  // ---- Menus ----------------------------------------------------------------------------
  const sortMenu = (at: Point) => {
    const s = sort.peek();
    const mark = (on: boolean, label: string) => `${on ? "✓ " : " "}${label}`;
    const dirs: MenuItem[] = ["separator", { label: mark(s.dir === 1, "Ascending"), run: () => sort.set({ ...s, dir: 1 }) }, { label: mark(s.dir === -1, "Descending"), run: () => sort.set({ ...s, dir: -1 }) }];
    contextMenu([...SORTS.map(([key, label]) => ({ label: mark(s.key === key, label), run: () => sort.set({ key, dir: key === "manual" ? 1 : s.dir }) })), ...(s.key === "manual" ? [] : dirs)], at, "Sort by");
  };
  /** What can be done with these entries (without Open and Rename). */
  const menuItems = (ids: string[]): MenuItem[] => {
    const es = ids.map((i) => entries.get(i)).filter((e) => !!e);
    const rs = es.flatMap((e) => (e.type === "record" ? [e.record] : []));
    const fs = es.flatMap((e) => (e.type === "folder" ? [e.path] : []));
    if (es.length !== 1) return es.length ? manyMenu(sp, rs, fs) : [];
    // This page renames in place, so not through Rename…'s dialog.
    return fs.length ? folderMenu(sp, fs[0]!) : recordActionsFor(rs).filter((a) => a.label !== "Rename…");
  };
  const menuFor = (ids: string[], at: Point) => {
    const one = ids.length === 1 ? entries.get(ids[0]!) : undefined;
    const more = menuItems(ids);
    if (!one) return void (more.length && contextMenu(more, at, `${ids.length} items`));
    contextMenu([{ label: "Open", run: () => open(one) }, { label: "Open in new tab", run: () => open(one, true) }, { label: "Rename", run: () => rename(one.id) }, ...(more.length ? ["separator" as const, ...more] : [])], at, one.name);
  };
  const backgroundMenu = (at: Point) =>
    contextMenu([
      { label: "New folder", run: () => void makeFolder() },
      "separator",
      { label: "Select all", run: () => (selection.set(order), markSelection()) },
      { label: view.peek() === "list" ? "View as icons" : "View as a list", run: () => view.set(view.peek() === "list" ? "icons" : "list") },
      { label: "Sort by…", run: () => sortMenu(at) },
    ], at, here ? nameOf(here) : sp.title);

  // ---- The pointer ----------------------------------------------------------------------
  const entryAt = (t: EventTarget | null) => (t as HTMLElement | null)?.closest<HTMLElement>("[role=option]") ?? null;
  const entryOf = (t: EventTarget | null) => entries.get(entryAt(t)?.dataset.id ?? "");
  let banded = false;
  body.addEventListener("click", (e) => {
    const el = entryAt(e.target);
    if (!el) {
      if (!e.metaKey && !e.shiftKey && !banded) selection.clear();
      banded = false;
      return markSelection();
    }
    focused = el.dataset.id!;
    selection.click(focused, order, { meta: e.metaKey, shift: e.shiftKey });
    markSelection();
    el.focus({ preventScroll: true });
  });
  // A middle-click opens in a new tab.
  body.addEventListener("mousedown", (e) => e.button === 1 && e.preventDefault());
  body.addEventListener("auxclick", (e) => {
    const en = entryOf(e.target);
    if (e.button === 1 && en) (e.preventDefault(), open(en, true));
  });
  body.addEventListener("dblclick", (e) => {
    const en = entryOf(e.target);
    if (en && !e.metaKey && !e.shiftKey) open(en);
  });
  body.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    const el = entryAt(e.target);
    if (!el) return backgroundMenu({ x: e.clientX, y: e.clientY });
    focused = el.dataset.id!;
    const ids = selection.forMenu(focused, order);
    markSelection();
    menuFor(ids, { x: e.clientX, y: e.clientY });
  });
  // Dragging what is selected (or the entry pressed, if it isn't) moves it.
  const stopDrag = dragSource(body, (t) => {
    const id = entryAt(t)?.dataset.id;
    if (!id || renaming) return null;
    if (!selection.ids.peek().has(id)) {
      selection.set([id], id);
      focused = id;
      markSelection();
    }
    return { payload: payload(selection.inOrder(order)), label: entries.get(id)?.name ?? "" };
  });
  // A box drawn on the background selects what it touches.
  body.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || entryAt(e.target) || renaming) return;
    const start = { x: e.clientX, y: e.clientY };
    const base = e.metaKey || e.shiftKey ? new Set(selection.ids.peek()) : new Set<string>();
    const band = h("div", { class: "select-band" });
    let moved = false;
    const move = (m: PointerEvent) => {
      const [x, y, w, ht] = [Math.min(start.x, m.clientX), Math.min(start.y, m.clientY), Math.abs(m.clientX - start.x), Math.abs(m.clientY - start.y)];
      if (!moved && w + ht < 4) return;
      if (!moved) document.body.appendChild(band);
      moved = true;
      Object.assign(band.style, { left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${ht}px` });
      const hit = new Set(base);
      for (const el of options()) {
        const r = el.getBoundingClientRect();
        if (r.right > x && r.left < x + w && r.bottom > y && r.top < y + ht) hit.add(el.dataset.id!);
      }
      selection.set(order.filter((i) => hit.has(i)));
      markSelection();
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      band.remove();
      banded = moved;
      if (moved) focusEntry(selection.inOrder(order)[0]);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  });

  // ---- The keyboard ---------------------------------------------------------------------
  let typed = "";
  let typedTimer: ReturnType<typeof setTimeout> | undefined;
  const columns = () => {
    if (view.peek() === "list") return 1;
    const els = options();
    return Math.max(1, els.filter((x) => x.offsetTop === els[0]?.offsetTop).length);
  };
  /** ⌥ and an arrow move what is selected one place along (arranging by hand). */
  const nudge = (k: string, cols: number) => {
    const sel = selection.inOrder(order);
    if (!sel.length && focused) sel.push(focused);
    if (!sel.length) return;
    const back = k === "ArrowUp" || k === "ArrowLeft";
    const step = k === "ArrowUp" || k === "ArrowDown" ? cols : 1;
    const edge = order.indexOf(back ? sel[0]! : sel.at(-1)!);
    const a = entries.get(order[back ? edge - step : edge + step] ?? order[back ? 0 : order.length - 1] ?? "");
    if (!a || sel.includes(a.id)) return;
    const keep = focused;
    void place(sp, here, payload(sel), keyOf(a), back ? "before" : "after").then(() => focusEntry(keep ?? undefined));
  };
  body.addEventListener("keydown", (e) => {
    if (renaming || (e.target as HTMLElement).tagName === "INPUT") return;
    const mod = e.metaKey;
    const i = focused ? order.indexOf(focused) : -1;
    const cols = columns();
    const k = e.key;
    const moveTo = (j: number) => {
      const to = order[Math.max(0, Math.min(order.length - 1, j))];
      if (!to) return;
      if (e.shiftKey) selection.extendTo(to, order);
      else selection.set([to], to);
      focusEntry(to);
    };
    if (isMenuKey(e)) {
      const el = elOf(focused);
      if (!el || !focused) backgroundMenu(menuPointFor(body));
      else {
        const ids = selection.forMenu(focused, order);
        markSelection();
        menuFor(ids, menuPointFor(el));
      }
    } else if (e.altKey && !mod && (k === "ArrowUp" || k === "ArrowDown" || (cols > 1 && (k === "ArrowLeft" || k === "ArrowRight")))) nudge(k, cols);
    else if (mod && k === "ArrowUp") goUp();
    else if ((mod && k === "ArrowDown") || k === "Enter") {
      // ⌘↩ opens in a new tab.
      const en = entries.get(focused ?? "");
      if (en) open(en, mod && k === "Enter");
    } else if (k === "ArrowDown") moveTo(i < 0 ? 0 : i + cols);
    else if (k === "ArrowUp") moveTo(i < 0 ? 0 : i - cols);
    else if (k === "ArrowRight" && cols > 1) moveTo(i + 1);
    else if (k === "ArrowLeft" && cols > 1) moveTo(i - 1);
    else if (k === "Home") moveTo(0);
    else if (k === "End") moveTo(order.length - 1);
    else if (mod && k.toLowerCase() === "a") {
      selection.set(order, focused ?? undefined);
      markSelection();
    } else if (k === "Escape" && selection.ids.peek().size) {
      selection.clear();
      markSelection();
    } else if (k === "F2") rename(focused);
    else if (k === " " && focused) {
      selection.click(focused, order, { meta: true, shift: false });
      markSelection();
    } else if (k.length === 1 && !mod && !e.altKey && /\S/.test(k)) {
      clearTimeout(typedTimer);
      typed += k.toLowerCase();
      typedTimer = setTimeout(() => (typed = ""), 700);
      const rest = [...order.slice(i + (typed.length > 1 ? 0 : 1)), ...order.slice(0, i + 1)];
      const hit = rest.find((id) => entries.get(id)?.name.toLowerCase().startsWith(typed));
      if (hit) {
        selection.set([hit], hit);
        focusEntry(hit);
      }
    } else return;
    e.preventDefault();
    e.stopPropagation();
  });
  // Keys for the whole page, outside text fields: ⌘↑ and ⌘A.
  const onWindowKey = (e: KeyboardEvent) => {
    // A page in a hidden tab hears none.
    if (renaming || document.querySelector("dialog[open], .context-menu") || host.closest("[hidden]")) return;
    if (isEditable(e.target) || body.contains(e.target as Node) || !e.metaKey) return;
    if (e.key === "ArrowUp") goUp();
    else if (!e.shiftKey && e.key.toLowerCase() === "a" && order.length) {
      selection.set(order);
      focusEntry(focused ?? order[0]);
    } else return;
    e.preventDefault();
  };
  window.addEventListener("keydown", onWindowKey);
  makers.set(host, () => void makeFolder());

  return () => {
    alive = false;
    stop();
    stopDrag();
    makers.delete(host);
    window.removeEventListener("keydown", onWindowKey);
    remember();
    if (hereSignal.peek()?.kind === kind && hereSignal.peek()?.folder === here) hereSignal.set(null);
    host.classList.remove("files-page");
  };
}
