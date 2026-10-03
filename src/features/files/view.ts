/**
 * The Files page: one folder's contents, as in Finder or Drive. A list (Name, Kind, Added) or
 * icons; folders first. A click selects (⌘-click and ⇧-click select several, a drag on the
 * background draws a box), a double-click or Return opens, ⌘↑ goes up. Items are dragged onto
 * folders, the path above or the sidebar to move them; F2 renames; the context menu (or the
 * menu key) offers everything else.
 */
import { h, replace } from "../../kit/dom";
import { icon, type IconNode } from "../../kit/icon";
import { effect, signal, untracked } from "../../kit/signal";
import { count } from "../../kit/format";
import { contextMenu, isMenuKey, menuPointFor, type MenuItem } from "../../kit/menu";
import { Selection } from "../../kit/selection";
import { dragSource, dropTarget, type DragPayload } from "../../kit/dnd";
import { toast } from "../../kit/toast";
import type { PageContext } from "../../shell/slots";
import type { RecordInfo } from "../../generated/RecordInfo";
import { ArrowDownUp, Folder, FolderPlus, LayoutGrid, List } from "lucide";
import { Contents, badFolderName, folderId, isFolderId, join, nameOf, parentOf, pathOfId, sortEntries, type Entry, type Sort, type SortKey } from "./model";
import { canMoveInto, moveInto, newFolder, renameFolder, renameRecord, type FolderStore } from "./ops";
import { uniqueName } from "./model";
import type { ShellApi } from "../../shell/api";

export interface FilesCtx {
  shell: ShellApi;
  store: FolderStore;
  /** What the folders hold (reads signals: call inside an effect). */
  contents(): Contents;
  /** The name shown for the top level (the library folder's name). */
  rootName(): string;
  iconOf(r: RecordInfo): IconNode;
  kindName(r: RecordInfo): string;
  detail(r: RecordInfo): string;
  /** A folder's context menu entries (beyond Open and Rename). */
  folderMenu(path: string): MenuItem[];
  /** Entries for several records and folders together. */
  manyMenu(records: RecordInfo[], folders: string[]): MenuItem[];
  /** Records' own entries (Move to…, Archive…). */
  recordMenu(rs: RecordInfo[]): MenuItem[];
}

/** The entry last focused in each folder, so going back up lands where one left. */
const lastFocus = new Map<string, string>();
/** An entry to select when a folder opens next ("Show in its folder"). */
let arrival: { folder: string; id: string } | null = null;
export function arriveWith(folder: string, id: string): void {
  arrival = { folder, id };
  lastFocus.set(folder, id);
}

const added = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : "");

export function renderFiles(fx: FilesCtx, host: HTMLElement, params: Record<string, string>, ctx: PageContext): () => void {
  const { shell } = fx;
  const here = params.folder ?? "";
  const view = shell.prefs.pref<"list" | "icons">("files.view", "list");
  const sort = shell.prefs.pref<Sort>("files.sort", { key: "name", dir: 1 });
  const filterText = signal("");
  const selection = new Selection();
  let order: string[] = [];
  let entries = new Map<string, Entry>();
  let focused: string | null = lastFocus.get(here) ?? null;
  if (arrival?.folder === here) selection.set([arrival.id], arrival.id);
  arrival = null;
  let renaming: string | null = null;
  let stale = false;
  let alive = true;
  shell.here.set(here);

  // ---- the frame -----------------------------------------------------------------------
  const crumbs = h("ol", { class: "crumbs" });
  const nav = h("nav", { class: "files-crumbs", "aria-label": "Folder path" }, crumbs);
  const filter = h("input", { class: "files-filter", type: "search", placeholder: "Filter this folder", "aria-label": "Filter this folder", spellcheck: false }) as HTMLInputElement;
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
  const sortButton = h("button", { class: "icon-button", type: "button", "aria-label": "Sort by", title: "Sort by", onclick: (e: MouseEvent) => sortMenu(menuPointFor(e.currentTarget as Element)) }, icon(ArrowDownUp, 16));
  const listButton = h("button", { class: "icon-button", type: "button", "aria-label": "As a list", title: "As a list", onclick: () => view.set("list") }, icon(List, 16));
  const iconsButton = h("button", { class: "icon-button", type: "button", "aria-label": "As icons", title: "As icons", onclick: () => view.set("icons") }, icon(LayoutGrid, 16));
  const bar = h("div", { class: "files-bar" }, nav, h("span", { class: "spacer" }), filter, sortButton, h("span", { class: "segmented", role: "group", "aria-label": "View" }, listButton, iconsButton));
  const head = h("div", { class: "files-head", role: "presentation" });
  const body = h("div", { class: "files-body", role: "listbox", "aria-multiselectable": "true", "aria-label": "Contents", tabindex: "-1" });
  const empty = h("div", { class: "files-empty" });
  const foot = h("div", { class: "files-foot", role: "status", "aria-live": "polite" });
  replace(host, bar, head, body, empty, foot);
  host.classList.add("files-page");
  ctx.setHeaderActions([h("button", { class: "icon-button", type: "button", "aria-label": "New folder", title: "New folder (⇧⌘N)", onclick: () => void makeFolder() }, icon(FolderPlus))]);

  const go = (folder: string) => {
    if (focused) lastFocus.set(here, focused);
    shell.router.go("files", folder ? { folder } : {});
  };
  const goUp = () => {
    if (!here) return;
    lastFocus.set(parentOf(here), folderId(here));
    go(parentOf(here));
  };
  const open = (e: Entry) => (e.type === "folder" ? go(e.path) : (lastFocus.set(here, e.id), shell.openRecord(e.id)));
  const payload = (ids: string[]): DragPayload => ({ records: ids.filter((i) => !isFolderId(i)), folders: ids.filter(isFolderId).map(pathOfId) });
  const dropInto = (el: HTMLElement, dest: string) =>
    dropTarget(el, {
      accepts: (p) => canMoveInto(shell, p, dest, fx.store.kinds()),
      drop: (p) => void moveInto(shell, fx.store, p, dest, fx.rootName()),
    });
  // Dropped on the background: into this folder (from the sidebar, say).
  dropInto(body, here);

  // ---- painting ------------------------------------------------------------------------
  const markSelection = () => {
    const s = selection.ids.peek();
    for (const el of body.querySelectorAll<HTMLElement>("[role=option]")) {
      const id = el.dataset.id!;
      el.setAttribute("aria-selected", String(s.has(id)));
      el.classList.toggle("selected", s.has(id));
      el.tabIndex = id === focused ? 0 : -1;
    }
    paintFoot();
  };
  let counts = "";
  const paintFoot = () => {
    const n = selection.ids.peek().size;
    foot.textContent = n ? `${n} selected · ${counts}` : counts;
  };
  const elOf = (id: string | null | undefined) => (id ? [...body.querySelectorAll<HTMLElement>("[role=option]")].find((x) => x.dataset.id === id) : undefined);
  const focusEntry = (id: string | undefined) => {
    if (!id) return;
    focused = id;
    markSelection();
    const el = elOf(id);
    el?.focus({ preventScroll: true });
    el?.scrollIntoView?.({ block: "nearest" });
  };

  const nameCell = (e: Entry) => {
    const name = h("span", { class: "files-name-text" }, e.name);
    const sub = e.type === "record" ? fx.detail(e.record) : "";
    return h("span", { class: "files-name" }, icon(e.type === "folder" ? Folder : fx.iconOf(e.record), view.peek() === "icons" ? 40 : 16), h("span", { class: "files-name-lines" }, name, sub && view.peek() === "icons" ? h("span", { class: "files-detail" }, sub) : null));
  };
  const entryEl = (e: Entry) => {
    const kind = e.type === "folder" ? `Folder · ${e.count ? count(e.count, "item") : "empty"}` : fx.kindName(e.record);
    const el = h("div", { role: "option", class: `files-entry ${e.type}`, tabindex: "-1", dataset: { id: e.id }, title: e.type === "record" && fx.detail(e.record) ? `${e.name}\n${fx.detail(e.record)}` : e.name },
      nameCell(e),
      view.peek() === "list" ? [h("span", { class: "files-kind" }, kind), h("span", { class: "files-added" }, e.type === "record" ? added(e.record.created) : "")] : null,
    );
    if (e.type === "folder") dropInto(el, e.path);
    return el;
  };

  const paint = () => {
    // Read first: what is read is what repaints it.
    const c = fx.contents();
    const v = view();
    const s = sort();
    const q = filterText().trim().toLowerCase();
    if (renaming) {
      stale = true;
      return;
    }
    if (here && !c.has(here)) {
      // Moved or removed elsewhere: show the nearest folder still there.
      let up = parentOf(here);
      while (up && !c.has(up)) up = parentOf(up);
      queueMicrotask(() => alive && shell.router.go("files", up ? { folder: up } : {}, { replace: true }));
      return;
    }
    ctx.setTitle(here ? nameOf(here) : fx.rootName());
    untracked(() => {
      // The path, each part a place to go and to drop on.
      const parts = ["", ...here.split("/").filter(Boolean).map((_, i, a) => a.slice(0, i + 1).join("/"))];
      replace(crumbs, parts.map((p) => {
        const current = p === here;
        const b = h("button", { class: "crumb", type: "button", "aria-current": current ? "location" : undefined, onclick: () => !current && go(p) }, p ? nameOf(p) : fx.rootName());
        if (!current) dropInto(b, p);
        return h("li", null, b);
      }));
      listButton.setAttribute("aria-pressed", String(v === "list"));
      iconsButton.setAttribute("aria-pressed", String(v === "icons"));
      const all = c.entries(here);
      const shown = sortEntries(q ? all.filter((e) => e.name.toLowerCase().includes(q)) : all, s, fx.kindName);
      entries = new Map(shown.map((e) => [e.id, e]));
      order = shown.map((e) => e.id);
      const kept = selection.inOrder(order);
      if (kept.length !== selection.ids.peek().size) selection.set(kept);
      if (!focused || !entries.has(focused)) focused = kept[0] ?? order[0] ?? null;
      const hadFocus = body.contains(document.activeElement);
      body.className = `files-body ${v}`;
      head.hidden = v !== "list" || !shown.length;
      const col = (key: SortKey, label: string) =>
        h("button", { class: `files-col ${key}`, type: "button", "aria-sort": s.key === key ? (s.dir === 1 ? "ascending" : "descending") : undefined, onclick: () => sort.set({ key, dir: s.key === key ? (-s.dir as 1 | -1) : 1 }) }, label, s.key === key ? h("span", { class: "files-arrow", "aria-hidden": "true" }, s.dir === 1 ? "▲" : "▼") : null);
      replace(head, col("name", "Name"), col("kind", "Kind"), col("added", "Added"));
      replace(body, shown.map(entryEl));
      const folders = all.filter((e) => e.type === "folder").length;
      counts = [folders ? count(folders, "folder") : "", all.length - folders ? count(all.length - folders, "item") : ""].filter(Boolean).join(", ") || "Empty";
      empty.hidden = shown.length > 0;
      replace(empty, q ? h("p", null, "Nothing in this folder matches.") : h("div", null, h("p", null, here ? "This folder is empty." : "Nothing here yet."), h("p", { class: "muted small" }, "Drag items here, make a new note (⌘N) or a folder (⇧⌘N), or add files and web pages from the File menu: they go into the folder you’re looking at.")));
      markSelection();
      if (hadFocus || document.activeElement === document.body || !document.activeElement) elOf(focused)?.focus({ preventScroll: true });
    });
  };
  const stop = effect(paint);

  // ---- renaming in place ---------------------------------------------------------------
  const rename = (id: string | null | undefined) => {
    const e = id ? entries.get(id) : undefined;
    const el = elOf(id);
    const text = el?.querySelector<HTMLElement>(".files-name-text");
    if (!e || !el || !text) return;
    if (e.type === "record" && e.record.read_only) return toast("This item can’t be renamed: it’s read-only.");
    renaming = e.id;
    const input = h("input", { class: "files-rename", value: e.name, "aria-label": `New name for “${e.name}”`, spellcheck: false }) as HTMLInputElement;
    text.replaceWith(input);
    input.focus();
    input.select();
    let done = false;
    const finish = async (save: boolean) => {
      if (done) return;
      done = true;
      const name = input.value.trim();
      let newId = e.id;
      if (save && name && name !== e.name) {
        if (e.type === "folder") {
          const bad = badFolderName(name);
          if (bad) toast(bad);
          else {
            const to = await renameFolder(shell, fx.store, e.path, name);
            if (to) newId = folderId(to);
          }
        } else await renameRecord(shell, e.id, name);
      }
      renaming = null;
      if (!alive) return;
      if (newId !== e.id) selection.set([newId], newId);
      focused = newId;
      stale = false;
      paint();
      focusEntry(newId);
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
    const c = untracked(fx.contents);
    const name = uniqueName("untitled folder", (n) => c.has(join(here, n)));
    const path = await newFolder(fx.store, join(here, name));
    if (!path || !alive) return;
    filter.value = "";
    filterText.set("");
    selection.set([folderId(path)], folderId(path));
    focused = folderId(path);
    paint();
    focusEntry(focused);
    rename(focused);
  };

  // ---- menus ---------------------------------------------------------------------------
  const sortMenu = (at: { x: number; y: number }) => {
    const s = sort.peek();
    const mark = (on: boolean, label: string) => `${on ? "✓ " : " "}${label}`;
    contextMenu([
      ...(["name", "kind", "added"] as SortKey[]).map((key) => ({ label: mark(s.key === key, key === "name" ? "Name" : key === "kind" ? "Kind" : "Date added"), run: () => sort.set({ key, dir: s.dir }) })),
      "separator",
      { label: mark(s.dir === 1, "Ascending"), run: () => sort.set({ ...s, dir: 1 }) },
      { label: mark(s.dir === -1, "Descending"), run: () => sort.set({ ...s, dir: -1 }) },
    ], at, "Sort by");
  };
  const menuFor = (ids: string[], at: { x: number; y: number }) => {
    const es = ids.map((i) => entries.get(i)).filter((e): e is Entry => !!e);
    const one = es.length === 1 ? es[0]! : null;
    const items: MenuItem[] = [];
    if (one) {
      items.push({ label: "Open", run: () => open(one) }, { label: "Rename", run: () => rename(one.id) });
      const more = one.type === "folder" ? fx.folderMenu(one.path) : fx.recordMenu([one.record]);
      if (more.length) items.push("separator", ...more);
      contextMenu(items, at, one.name);
    } else if (es.length) {
      const rs = es.flatMap((e) => (e.type === "record" ? [e.record] : []));
      const fs = es.flatMap((e) => (e.type === "folder" ? [e.path] : []));
      contextMenu(fx.manyMenu(rs, fs), at, `${es.length} items`);
    }
  };
  const backgroundMenu = (at: { x: number; y: number }) => {
    contextMenu([
      { label: "New folder", run: () => void makeFolder() },
      "separator",
      { label: "Select all", run: () => (selection.set(order), markSelection()) },
      { label: view.peek() === "list" ? "View as icons" : "View as a list", run: () => view.set(view.peek() === "list" ? "icons" : "list") },
      { label: "Sort by…", run: () => sortMenu(at) },
    ], at, here ? nameOf(here) : fx.rootName());
  };

  // ---- mouse ---------------------------------------------------------------------------
  const entryAt = (t: EventTarget | null) => (t as HTMLElement | null)?.closest<HTMLElement>("[role=option]") ?? null;
  body.addEventListener("click", (e) => {
    const el = entryAt(e.target);
    if (!el) {
      if (!e.metaKey && !e.shiftKey && !banded) selection.clear();
      banded = false;
      markSelection();
      return;
    }
    const id = el.dataset.id!;
    focused = id;
    selection.click(id, order, { meta: e.metaKey || e.ctrlKey, shift: e.shiftKey });
    markSelection();
    el.focus({ preventScroll: true });
  });
  body.addEventListener("dblclick", (e) => {
    const el = entryAt(e.target);
    const en = el ? entries.get(el.dataset.id!) : undefined;
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
  // Dragging what is selected (or the item pressed, if it isn't) onto a folder moves it.
  const stopDrag = dragSource(body, (t) => {
    const el = entryAt(t);
    if (!el || renaming) return null;
    const id = el.dataset.id!;
    if (!selection.ids.peek().has(id)) {
      selection.set([id], id);
      focused = id;
      markSelection();
    }
    const ids = selection.inOrder(order);
    return { payload: payload(ids), label: entries.get(id)?.name ?? "" };
  });

  // A box drawn on the background selects what it touches.
  let banded = false;
  body.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || entryAt(e.target) || renaming) return;
    const start = { x: e.clientX, y: e.clientY };
    const base = e.metaKey || e.shiftKey ? new Set(selection.ids.peek()) : new Set<string>();
    const band = h("div", { class: "select-band" });
    let moved = false;
    const move = (m: PointerEvent) => {
      const x = Math.min(start.x, m.clientX);
      const y = Math.min(start.y, m.clientY);
      const w = Math.abs(m.clientX - start.x);
      const ht = Math.abs(m.clientY - start.y);
      if (!moved && w + ht < 4) return;
      if (!moved) {
        moved = true;
        document.body.appendChild(band);
      }
      Object.assign(band.style, { left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${ht}px` });
      const hit = new Set(base);
      for (const el of body.querySelectorAll<HTMLElement>("[role=option]")) {
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
      if (moved) {
        const first = selection.inOrder(order)[0];
        if (first) focusEntry(first);
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  });

  // ---- keyboard ------------------------------------------------------------------------
  let typed = "";
  let typedTimer: ReturnType<typeof setTimeout> | undefined;
  const columns = () => {
    if (view.peek() === "list") return 1;
    const els = [...body.querySelectorAll<HTMLElement>("[role=option]")];
    const top = els[0]?.offsetTop;
    const n = els.filter((x) => x.offsetTop === top).length;
    return Math.max(1, n);
  };
  body.addEventListener("keydown", (e) => {
    if (renaming || (e.target as HTMLElement).tagName === "INPUT") return;
    const mod = e.metaKey || e.ctrlKey;
    const i = focused ? order.indexOf(focused) : -1;
    const moveTo = (j: number) => {
      const to = order[Math.max(0, Math.min(order.length - 1, j))];
      if (!to) return;
      if (e.shiftKey) selection.extendTo(to, order);
      else selection.set([to], to);
      focusEntry(to);
    };
    const cols = columns();
    const k = e.key;
    if (isMenuKey(e)) {
      const el = elOf(focused);
      if (!el || !focused) return backgroundMenu(menuPointFor(body));
      const ids = selection.forMenu(focused, order);
      markSelection();
      menuFor(ids, menuPointFor(el));
    } else if (mod && k === "ArrowUp") goUp();
    else if ((mod && k === "ArrowDown") || (k === "Enter" && !mod)) {
      const en = focused ? entries.get(focused) : undefined;
      if (en) open(en);
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
  // Keys for the whole page (outside text fields): ⌘↑, ⌘A, ⇧⌘N.
  const onWindowKey = (e: KeyboardEvent) => {
    if (renaming || document.querySelector("dialog[open], .context-menu")) return;
    const t = e.target as HTMLElement | null;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) || body.contains(t)) return;
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key === "ArrowUp") goUp();
    else if (mod && !e.shiftKey && e.key.toLowerCase() === "a" && order.length) {
      selection.set(order);
      focusEntry(focused ?? order[0]);
    } else return;
    e.preventDefault();
  };
  window.addEventListener("keydown", onWindowKey);
  const offNew = registerNewFolder(() => void makeFolder());

  return () => {
    alive = false;
    stop();
    stopDrag();
    offNew();
    window.removeEventListener("keydown", onWindowKey);
    if (focused) lastFocus.set(here, focused);
    if (shell.here.peek() === here) shell.here.set(null);
    host.classList.remove("files-page");
    if (stale) stale = false;
  };
}

/** The page showing now makes new folders (the "New folder" action). */
let newFolderHere: (() => void) | null = null;
function registerNewFolder(fn: () => void): () => void {
  newFolderHere = fn;
  return () => {
    if (newFolderHere === fn) newFolderHere = null;
  };
}
export function makeFolderHere(): boolean {
  if (!newFolderHere) return false;
  newFolderHere();
  return true;
}
