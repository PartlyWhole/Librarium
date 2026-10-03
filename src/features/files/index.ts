/**
 * Files: the user's folders, across notes and library items, browsed as in Finder or Drive.
 * A page per folder, a folder tree in the sidebar (each folder a place to drop things on), and
 * "Move to folder…" wherever a record has a menu.
 */
import { call } from "../../backend";
import { h } from "../../kit/dom";
import { modal } from "../../kit/dialog";
import { signal, effect, untracked } from "../../kit/signal";
import { toast } from "../../kit/toast";
import type { MenuItem } from "../../kit/menu";
import { contextMenu } from "../../kit/menu";
import type { TreeNode } from "../../kit/tree";
import { zone, type DragPayload } from "../../kit/dnd";
import type { ShellApi } from "../../shell/api";
import type { RecordInfo } from "../../generated/RecordInfo";
import type { FoldersList } from "../../generated/FoldersList";
import { FileText, Folder, FolderOpen, FolderTree } from "lucide";
import { Contents, badFolderName, folderOf, join, keyOf, nameOf, parentOf, placed, sortEntries, within, type Sort } from "./model";
import { canMoveInto, canPlaceIn, moveInto, newFolder, pickFolder, removeFolder, renameFolder, type FolderStore } from "./ops";
import { arriveWith, makeFolderHere, renderFiles, type FilesCtx } from "./view";

const PAGE = "files";
const folderKey = (name: string) => `folder:${name}`;

/** Asks for a name (for menus where the name can't be edited in place). */
function askName(title: string, initial: string, action: string): Promise<string | null> {
  return new Promise((resolve) => {
    let result: string | null = null;
    const input = h("input", { class: "combo-input", value: initial, "aria-label": "Folder name", spellcheck: false }) as HTMLInputElement;
    const error = h("p", { class: "muted small", "aria-live": "polite" });
    const submit = () => {
      const bad = badFolderName(input.value);
      if (bad) return void (error.textContent = bad);
      result = input.value.trim();
      m.close();
    };
    input.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      submit();
    });
    const m = modal(
      h("div", { class: "ask" },
        h("h2", { class: "ask-title" }, title),
        input,
        error,
        h("div", { class: "ask-buttons" }, h("button", { class: "button", type: "button", onclick: () => m.close() }, "Cancel"), h("button", { class: "button primary", type: "button", onclick: submit }, action)),
      ),
      { label: title, onClose: () => resolve(result) },
    );
    input.focus();
    input.select();
  });
}

export function files(shell: ShellApi): void {
  // ---- the folders, from the backend (records' own folders come from their paths) -------
  const folders = signal<string[]>([]);
  const kinds = signal<string[]>(["note", "item"]);
  const order = signal<Record<string, string[]>>({});
  const store: FolderStore = {
    list: () => untracked(contents).folders,
    kinds: () => kinds.peek(),
    order: (folder) => order()[folder] ?? [],
    async refresh() {
      try {
        const l = await call<FoldersList>("folders.list");
        kinds.set(l.kinds);
        order.set(l.order);
        folders.set(l.folders);
      } catch {
        /* no library open */
      }
    },
  };
  effect(() => {
    if (shell.folder()?.state === "open") void store.refresh();
    else folders.set([]);
  });
  // Folders made or removed in Finder show up when the window comes back.
  window.addEventListener("focus", () => void (shell.folder.peek()?.state === "open" && store.refresh()));

  let memo: { f: string[]; m: Map<string, RecordInfo>; k: string[]; c: Contents } | null = null;
  const contents = (): Contents => {
    const f = folders();
    const m = shell.records.byId();
    const k = kinds();
    if (memo && memo.f === f && memo.m === m && memo.k === k) return memo.c;
    const c = new Contents(f, [...m.values()], k, (r) => shell.records.isHidden(r));
    memo = { f, m, k, c };
    return c;
  };
  const rootName = () => {
    const p = shell.folder()?.path ?? "";
    return p.split("/").filter(Boolean).pop() ?? "Library";
  };
  const look = (r: RecordInfo) => shell.looks.get(r.kind);
  const go = (folder: string) => shell.router.go(PAGE, folder ? { folder } : {});
  const sort = shell.prefs.pref<Sort>("files.sort", { key: "name", dir: 1 });
  const kindName = (r: RecordInfo) => look(r)?.kindName(r) ?? r.kind;
  /** A folder's entries as they are shown. */
  const sorted = (folder: string) => sortEntries(contents().entries(folder), sort(), kindName, store.order(folder));

  /**
   * Places dragged things just before or after an entry of `folder` (moving them there first
   * if they are elsewhere), and from then on shows folders as arranged by hand.
   */
  const place = async (folder: string, p: DragPayload, anchor: string, where: "before" | "after") => {
    const outside = {
      records: p.records.filter((id) => {
        const r = shell.records.get(id);
        return r && folderOf(r) !== folder;
      }),
      folders: p.folders.filter((f) => parentOf(f) !== folder),
    };
    const moving = outside.records.length + outside.folders.length > 0;
    if (moving) await moveInto(shell, store, outside, folder, rootName());
    const keys = [...p.records, ...p.folders.map((f) => folderKey(nameOf(f)))];
    const before = untracked(() => sorted(folder)).map(keyOf);
    const next = placed(before, keys, anchor, where);
    const prevOrder = order.peek()[folder];
    const prevSort = sort.peek();
    try {
      await call("folders.setOrder", { path: folder, order: next });
    } catch (e) {
      return toast(String((e as { message?: string }).message ?? e));
    }
    order.set({ ...order.peek(), [folder]: next });
    if (prevSort.key !== "manual") {
      sort.set({ key: "manual", dir: 1 });
      shell.status.show("Now arranged by hand. Sort by name, kind or date to go back.", 8000);
    }
    // A move already offered its own Undo.
    if (moving) return;
    shell.undo.done(keys.length === 1 ? "Moved it there." : `Moved ${keys.length} items there.`, {
      label: "arranging",
      undo: async () => {
        await call("folders.setOrder", { path: folder, order: prevOrder ?? [] });
        order.set({ ...order.peek(), [folder]: prevOrder ?? [] });
        sort.set(prevSort);
      },
    });
  };

  // ---- menus ----------------------------------------------------------------------------
  const moveRecords = async (rs: RecordInfo[], folderPaths: string[] = []) => {
    const dest = await pickFolder(store, {
      label: rs.length + folderPaths.length === 1 ? `Move “${rs[0]?.title ?? nameOf(folderPaths[0]!)}” to` : `Move ${rs.length + folderPaths.length} items to`,
      root: rootName(),
      exclude: (f) => folderPaths.some((p) => within(f, p)) || (rs.length === 0 && folderPaths.every((p) => parentOf(p) === f)),
    });
    if (dest === null) return;
    const p = { records: rs.map((r) => r.id), folders: folderPaths };
    if (!canMoveInto(shell, p, dest, store.kinds())) return toast("They’re already there.");
    await moveInto(shell, store, p, dest, rootName());
  };
  const insideActions = (rs: RecordInfo[]): MenuItem[] =>
    rs.length
      ? shell.recordActionsFor(rs).filter((a) => !a.label.startsWith("Move ")).map((a) => ({ ...a, label: rs.length === 1 ? `${a.label} (the one item inside)` : `${a.label} inside` }))
      : [];
  const newFolderIn = async (parent: string) => {
    const c = untracked(contents);
    let name = "untitled folder";
    for (let i = 2; c.has(join(parent, name)); i++) name = `untitled folder ${i}`;
    const typed = await askName(parent ? `New folder in “${nameOf(parent)}”` : "New folder", name, "Make folder");
    if (!typed) return;
    const path = await newFolder(store, join(parent, typed));
    if (path) shell.status.show(`Made the folder “${typed}”.`);
  };
  const folderMenu = (path: string): MenuItem[] => {
    const c = untracked(contents);
    const items: MenuItem[] = [
      { label: "New folder inside…", run: () => void newFolderIn(path) },
      { label: "Move to…", run: () => void moveRecords([], [path]) },
    ];
    const inside = insideActions(c.recordsUnder(path));
    if (inside.length) items.push("separator", ...inside);
    if (!c.entries(path).length) items.push("separator", { label: "Remove folder", destructive: true, run: () => void removeFolder(shell, store, path) });
    return items;
  };
  const manyMenu = (rs: RecordInfo[], fs: string[]): MenuItem[] => {
    const c = untracked(contents);
    const n = rs.length + fs.length;
    const items: MenuItem[] = [{ label: `Move ${n} items to…`, run: () => void moveRecords(rs, fs) }];
    const all = [...rs, ...fs.flatMap((f) => c.recordsUnder(f))];
    const acts = shell.recordActionsFor(all).filter((a) => !a.label.startsWith("Move "));
    if (acts.length) items.push("separator", ...acts);
    return items;
  };
  const showFolderMenu = (path: string, at: { x: number; y: number }) => {
    contextMenu([
      { label: "Open", run: () => go(path) },
      {
        label: "Rename…",
        run: async () => {
          const name = await askName(`Rename “${nameOf(path)}”`, nameOf(path), "Rename");
          if (!name) return;
          const to = await renameFolder(shell, store, path, name);
          const r = shell.router.current.peek();
          // Keep showing it (or what's inside it) under its new name.
          if (to && r.page === PAGE && within(r.params.folder ?? "", path)) go(to + (r.params.folder ?? "").slice(path.length));
        },
      },
      "separator",
      ...folderMenu(path),
    ], at, nameOf(path));
  };

  const fx: FilesCtx = {
    shell,
    store,
    contents,
    rootName,
    iconOf: (r) => look(r)?.icon(r) ?? FileText,
    kindName,
    place,
    detail: (r) => look(r)?.detail?.(r) ?? "",
    folderMenu,
    manyMenu,
    recordMenu: (rs) => shell.recordActionsFor(rs),
  };

  // ---- the page -------------------------------------------------------------------------
  shell.pages.add("files", PAGE, {
    id: PAGE,
    title: "Files",
    icon: FolderOpen,
    ribbon: 1.5,
    keys: "Mod+Shift+E",
    render: (host, params, ctx) => renderFiles(fx, host, params, ctx),
  });

  // ---- the sidebar: the folder tree -----------------------------------------------------
  const dropOn = (dest: string) => ({
    accepts: (p: { records: string[]; folders: string[] }) => canMoveInto(shell, p, dest, kinds.peek()),
    drop: (p: { records: string[]; folders: string[] }) => void moveInto(shell, store, p, dest, rootName()),
  });
  shell.sidebar.add("files", "folders", {
    id: "folders",
    title: "Folders",
    emptyText: "No folders yet.",
    nodes() {
      const r = shell.router.current();
      const at = r.page === PAGE ? r.params.folder ?? "" : null;
      // Subfolders in the order the page shows them (as arranged, when that is the sort).
      const subs = (path: string) => sorted(path).flatMap((e) => (e.type === "folder" ? [e.path] : []));
      const node = (path: string): TreeNode => ({
        id: `files:${path}`,
        label: nameOf(path),
        icon: at === path ? FolderOpen : Folder,
        current: at === path,
        children: subs(path).map(node),
        onActivate: () => go(path),
        onContext: (p) => showFolderMenu(path, p),
        drag: () => ({ records: [], folders: [path] }),
        drop: {
          // Its top and bottom edges place things beside it; the middle moves them in.
          accepts: (p) => canMoveInto(shell, p, path, kinds.peek()) || canPlaceIn(shell, p, parentOf(path), kinds.peek()),
          where: (p, x, y, el) => {
            if (p.folders.includes(path)) return null;
            const w = zone(el, x, y, { into: canMoveInto(shell, p, path, kinds.peek()) });
            return w === "into" || canPlaceIn(shell, p, parentOf(path), kinds.peek()) ? w : null;
          },
          drop: (p, w) => void (w === "into" ? moveInto(shell, store, p, path, rootName()) : place(parentOf(path), p, folderKey(nameOf(path)), w)),
        },
      });
      return [{
        id: "files:",
        label: rootName(),
        icon: FolderTree,
        current: at === "",
        children: subs("").map(node),
        onActivate: () => go(""),
        onContext: (p) => contextMenu([{ label: "Open", run: () => go("") }, { label: "New folder…", run: () => void newFolderIn("") }], p, rootName()),
        drop: dropOn(""),
      }];
    },
  }, -1);

  // ---- actions ---------------------------------------------------------------------------
  const libraryOpen = () => shell.folder()?.state === "open";
  shell.actions.add("files", {
    id: "files.newFolder",
    title: "New folder",
    keys: ["Mod+Shift+N"],
    when: libraryOpen,
    menu: { name: "file", group: 0 },
    icon: Folder,
    run: () => {
      if (makeFolderHere()) return;
      go(shell.here.peek() ?? "");
      setTimeout(() => makeFolderHere(), 0);
    },
  });
  const currentRecord = () => {
    const id = shell.router.current().params.id;
    const r = id ? shell.records.get(id) : undefined;
    return r && kinds().includes(r.kind) && !r.read_only ? r : undefined;
  };
  shell.actions.add("files", {
    id: "files.moveTo",
    title: "Move to folder…",
    when: () => !!currentRecord(),
    menu: { name: "file", group: 2 },
    run: () => {
      const r = untracked(currentRecord);
      if (r) void moveRecords([r]);
    },
  });
  shell.actions.add("files", {
    id: "files.showInFolder",
    title: "Show in its folder",
    when: () => !!currentRecord(),
    menu: { name: "file", group: 2 },
    run: () => {
      const r = untracked(currentRecord);
      if (!r) return;
      // Lands with the record selected.
      arriveWith(folderOf(r), r.id);
      go(folderOf(r));
    },
  });

  // Every record kept in folders can be moved from its menu.
  shell.recordActions.add("files", "move", {
    label: (n) => (n === 1 ? "Move to folder…" : `Move ${n} items to folder…`),
    applies: (r) => kinds.peek().includes(r.kind) && !r.read_only,
    partial: true,
    run: (rs) => void moveRecords(rs),
  });
}
