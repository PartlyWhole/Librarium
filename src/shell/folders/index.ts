/**
 * Folders: each kind kept in folders (notes, library items) has its own, browsed as in Finder.
 * The feature owning a kind adds it as a space; this gives it a page (one folder at a time), a
 * sidebar tree (folders and records, each folder a place to drop things on), and "Move to
 * folder…" wherever its records have a menu.
 */
import { call } from "../../backend";
import { h } from "../../kit/dom";
import { modal } from "../../kit/dialog";
import { signal, effect, untracked, type Signal } from "../../kit/signal";
import { toast } from "../../kit/toast";
import { contextMenu, type MenuItem } from "../../kit/menu";
import type { TreeNode } from "../../kit/tree";
import { zone, type DragPayload, type DropTarget } from "../../kit/dnd";
import type { Folders, FolderSpace, PageContext, ShellApi } from "../slots";
import type { RecordInfo } from "../../generated/RecordInfo";
import type { FoldersList } from "../../generated/FoldersList";
import { FileText, Folder, FolderOpen } from "lucide";
import { Contents, badFolderName, folderOf, join, keyOf, nameOf, parentOf, placed, sortEntries, within, type FolderEntry, type Sort } from "./model";
import { canMoveInto, canPlaceIn, moveInto, newFolder, pickFolder, removeFolder, renameFolder, renameRecord, type FolderStore } from "./ops";
import { arriveWith, makeFolderHere, renderFiles, type FilesCtx } from "./view";

const folderKey = (name: string) => `folder:${name}`;

/** Asks for a name (for menus where the name can't be edited in place). */
function askName(title: string, initial: string, action: string, of: "folder" | "title" = "folder"): Promise<string | null> {
  return new Promise((resolve) => {
    let result: string | null = null;
    const input = h("input", { class: "combo-input", value: initial, "aria-label": of === "folder" ? "Folder name" : "Title", spellcheck: of === "title" }) as HTMLInputElement;
    const error = h("p", { class: "muted small", "aria-live": "polite" });
    const submit = () => {
      // A title can hold any characters (its file name is made from it); a folder's can't.
      const bad = of === "folder" ? badFolderName(input.value) : input.value.trim() ? null : "A title can’t be empty.";
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

/** One kind's folders, with everything its page and tree need. */
interface Space {
  def: FolderSpace;
  store: FolderStore;
  contents(): Contents;
  sort: Signal<Sort>;
  sorted(folder: string): FolderEntry[];
  fx: FilesCtx;
  moveRecords(rs: RecordInfo[], folders?: string[]): Promise<void>;
  showFolderMenu(path: string, at: { x: number; y: number }): void;
  topMenu(): MenuItem[];
  newFolderIn(parent: string): Promise<void>;
}

export function createFolders(shell: ShellApi): Folders {
  const spaces = new Map<string, Space>();
  const listed = signal<FoldersList["spaces"]>([]);
  const refresh = async () => {
    try {
      listed.set((await call<FoldersList>("folders.list")).spaces);
    } catch {
      /* no library open */
    }
  };
  effect(() => {
    if (shell.folder()?.state === "open") void refresh();
    else listed.set([]);
  });
  // Folders made or removed in Finder show up when the window comes back.
  window.addEventListener("focus", () => void (shell.folder.peek()?.state === "open" && refresh()));

  const look = (r: RecordInfo) => shell.looks.get(r.kind);
  const kindName = (r: RecordInfo) => look(r)?.kindName(r) ?? r.kind;
  const spaceOf = (kind: string) => spaces.get(kind);
  const go = (sp: Space, folder: string) => shell.router.go(sp.def.page, folder ? { folder } : {});

  const make = (def: FolderSpace): Space => {
    const kind = def.kind;
    const mine = () => listed().find((x) => x.kind === kind);
    const store: FolderStore = {
      kind,
      list: () => untracked(contents).folders,
      order: (folder) => mine()?.order[folder] ?? [],
      refresh,
    };
    let memo: { f: unknown; m: Map<string, RecordInfo>; c: Contents } | null = null;
    const contents = (): Contents => {
      const l = mine();
      const m = shell.records.byId();
      if (memo && memo.f === l && memo.m === m) return memo.c;
      const all = [...m.values()].filter((r) => r.kind === kind);
      const c = new Contents(l?.folders ?? [], all, (r) => shell.records.isHidden(r));
      memo = { f: l, m, c };
      return c;
    };
    const sort = shell.prefs.pref<Sort>(`folders.sort.${kind}`, { key: "name", dir: 1 });
    const sorted = (folder: string) => sortEntries(contents().entries(folder), sort(), kindName, store.order(folder));
    const sp = { def, store, contents, sort, sorted } as Space;

    /**
     * Places dragged things just before or after an entry of `folder` (moving them there first
     * if they are elsewhere), and from then on shows the space as arranged by hand.
     */
    const place = async (folder: string, p: DragPayload, anchor: string, where: "before" | "after") => {
      const outside: DragPayload = {
        kind,
        records: p.records.filter((id) => {
          const r = shell.records.get(id);
          return r && folderOf(r) !== folder;
        }),
        folders: p.folders.filter((f) => parentOf(f) !== folder),
      };
      const moving = outside.records.length + outside.folders.length > 0;
      if (moving) await moveInto(shell, store, outside, folder, def.title);
      const keys = [...p.records, ...p.folders.map((f) => folderKey(nameOf(f)))];
      const before = untracked(() => sorted(folder)).map(keyOf);
      const next = placed(before, keys, anchor, where);
      const prevOrder = store.order(folder);
      const prevSort = sort.peek();
      const save = async (order: string[]) => {
        await call("folders.setOrder", { kind, path: folder, order });
        listed.set(listed.peek().map((x) => (x.kind === kind ? { ...x, order: { ...x.order, [folder]: order } } : x)));
      };
      try {
        await save(next);
      } catch (e) {
        return toast(String((e as { message?: string }).message ?? e));
      }
      if (prevSort.key !== "manual") {
        sort.set({ key: "manual", dir: 1 });
        shell.status.show("Now arranged by hand. Sort by name, kind or date to go back.", 8000);
      }
      // A move already offered its own Undo.
      if (moving) return;
      shell.undo.done(keys.length === 1 ? "Moved it there." : `Moved ${keys.length} items there.`, {
        label: "arranging",
        undo: async () => {
          await save(prevOrder);
          sort.set(prevSort);
        },
        redo: async () => {
          await save(next);
          sort.set({ key: "manual", dir: 1 });
        },
      });
    };

    // ---- menus --------------------------------------------------------------------------
    const moveRecords = async (rs: RecordInfo[], folderPaths: string[] = []) => {
      const dest = await pickFolder(store, {
        label: rs.length + folderPaths.length === 1 ? `Move “${rs[0]?.title ?? nameOf(folderPaths[0]!)}” to` : `Move ${rs.length + folderPaths.length} items to`,
        root: def.title,
        exclude: (f) => folderPaths.some((p) => within(f, p)) || (rs.length === 0 && folderPaths.every((p) => parentOf(p) === f)),
      });
      if (dest === null) return;
      const p = { kind, records: rs.map((r) => r.id), folders: folderPaths };
      if (!canMoveInto(shell, p, dest, kind)) return toast("They’re already there.");
      await moveInto(shell, store, p, dest, def.title);
    };
    const insideActions = (rs: RecordInfo[]): MenuItem[] =>
      rs.length
        ? shell.recordActionsFor(rs).filter((a) => !a.label.startsWith("Move ")).map((a) => ({ ...a, label: rs.length === 1 ? `${a.label} (the one item inside)` : `${a.label} inside` }))
        : [];
    const newFolderIn = async (parent: string) => {
      const c = untracked(contents);
      let name = "untitled folder";
      for (let i = 2; c.has(join(parent, name)); i++) name = `untitled folder ${i}`;
      const typed = await askName(parent ? `New folder in “${nameOf(parent)}”` : `New folder in ${def.title}`, name, "Make folder");
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
      const acts = shell.recordActionsFor([...rs, ...fs.flatMap((f) => c.recordsUnder(f))]).filter((a) => !a.label.startsWith("Move "));
      if (acts.length) items.push("separator", ...acts);
      return items;
    };
    const showFolderMenu = (path: string, at: { x: number; y: number }) => {
      contextMenu([
        { label: "Open", run: () => go(sp, path) },
        { label: "Open in new tab", run: () => shell.router.go(def.page, { folder: path }, { newTab: true }) },
        {
          label: "Rename…",
          run: async () => {
            const name = await askName(`Rename “${nameOf(path)}”`, nameOf(path), "Rename");
            if (!name) return;
            const to = await renameFolder(shell, store, path, name);
            const r = shell.router.current.peek();
            // Keep showing it (or what's inside it) under its new name.
            if (to && r.page === def.page && within(r.params.folder ?? "", path)) go(sp, to + (r.params.folder ?? "").slice(path.length));
          },
        },
        "separator",
        ...folderMenu(path),
      ], at, nameOf(path));
    };

    sp.fx = {
      shell,
      space: def,
      store,
      contents,
      sort,
      view: shell.prefs.pref<"list" | "icons">(`folders.view.${kind}`, "list"),
      rootName: () => def.title,
      iconOf: (r) => look(r)?.icon(r) ?? FileText,
      kindName,
      detail: (r) => look(r)?.detail?.(r) ?? "",
      place,
      folderMenu,
      manyMenu,
      // The Files page renames in place (its own Rename), so not through a dialog too.
      recordMenu: (rs) => shell.recordActionsFor(rs).filter((a) => a.label !== "Rename…"),
    };
    sp.moveRecords = moveRecords;
    sp.showFolderMenu = showFolderMenu;
    sp.newFolderIn = newFolderIn;
    sp.topMenu = () => [
      { label: `Open ${def.title}`, run: () => go(sp, "") },
      { label: "Open in new tab", run: () => shell.router.go(def.page, {}, { newTab: true }) },
      "separator",
      { label: "New folder…", run: () => void newFolderIn("") },
    ];
    return sp;
  };

  // ---- the sidebar tree ----------------------------------------------------------------
  const tree = (kind: string): TreeNode[] => {
    const sp = spaceOf(kind);
    if (!sp) return [];
    const r = shell.router.current();
    const at = r.page === sp.def.page ? r.params.folder ?? "" : null;
    const openId = r.params.id;
    const store = sp.store;
    const entries = (path: string): TreeNode[] =>
      sp.sorted(path).map((e): TreeNode => {
        if (e.type === "record") {
          const kids = sp.def.children?.(e.record) ?? [];
          return {
            id: e.id,
            label: e.name,
            icon: sp.fx.iconOf(e.record),
            current: openId === e.id,
            onActivate: () => shell.openRecord(e.id),
            drag: () => ({ records: [e.id], folders: [], kind }),
            drop: {
              accepts: (p) => canPlaceIn(shell, p, path, kind) && !p.records.includes(e.id),
              where: (_p, x, y, el) => zone(el, x, y, { into: false }),
              drop: (p, w) => void (w !== "into" && sp.fx.place(path, p, e.id, w)),
            },
            ...(kids.length ? { children: kids, startCollapsed: true } : {}),
          };
        }
        const f = e.path;
        return {
          id: `folder:${kind}:${f}`,
          label: e.name,
          icon: at === f ? FolderOpen : Folder,
          current: at === f,
          children: entries(f),
          onActivate: () => go(sp, f),
          onOpenNew: () => shell.router.go(sp.def.page, { folder: f }, { newTab: true }),
          onContext: (p) => sp.showFolderMenu(f, p),
          drag: () => ({ records: [], folders: [f], kind }),
          drop: {
            // Its top and bottom edges place things beside it; the middle moves them in.
            accepts: (p) => canMoveInto(shell, p, f, kind) || canPlaceIn(shell, p, path, kind),
            where: (p, x, y, el) => {
              if (p.folders.includes(f)) return null;
              const w = zone(el, x, y, { into: canMoveInto(shell, p, f, kind) });
              return w === "into" || canPlaceIn(shell, p, path, kind) ? w : null;
            },
            drop: (p, w) => void (w === "into" ? moveInto(shell, store, p, f, sp.def.title) : sp.fx.place(path, p, folderKey(e.name), w)),
          },
        };
      });
    return entries("");
  };

  // ---- actions ----------------------------------------------------------------------------
  const libraryOpen = () => shell.folder()?.state === "open";
  shell.actions.add("shell", {
    id: "folders.newFolder",
    title: "New folder",
    keys: ["Mod+Shift+N"],
    when: libraryOpen,
    menu: { name: "file", group: 0 },
    icon: Folder,
    run: () => {
      if (makeFolderHere()) return;
      const here = shell.here.peek();
      const sp = spaceOf(here?.kind ?? "") ?? spaces.values().next().value;
      if (!sp) return;
      go(sp, here?.folder ?? "");
      setTimeout(() => makeFolderHere(), 0);
    },
  });
  const currentRecord = () => {
    const id = shell.router.current().params.id;
    const r = id ? shell.records.get(id) : undefined;
    return r && spaces.has(r.kind) && !r.read_only ? r : undefined;
  };
  shell.actions.add("shell", {
    id: "folders.moveTo",
    title: "Move to folder…",
    when: () => !!currentRecord(),
    menu: { name: "file", group: 2 },
    run: () => {
      const r = untracked(currentRecord);
      if (r) void spaceOf(r.kind)!.moveRecords([r]);
    },
  });
  shell.actions.add("shell", {
    id: "folders.showInFolder",
    title: "Show in its folder",
    when: () => !!currentRecord(),
    menu: { name: "file", group: 2 },
    run: () => {
      const r = untracked(currentRecord);
      if (!r) return;
      // Lands with the record selected.
      arriveWith(folderOf(r), r.id);
      go(spaceOf(r.kind)!, folderOf(r));
    },
  });
  // Every record kept in folders can be moved from its menu (records of one kind at a time).
  // Renaming from any record's menu (the sidebar's, the Files page's): its file name follows.
  shell.recordActions.add("shell", "rename", {
    label: "Rename…",
    single: true,
    applies: (r) => spaces.has(r.kind) && !r.read_only && !shell.records.isHidden(r),
    run: async (rs) => {
      const r = rs[0];
      if (rs.length !== 1 || !r) return;
      const name = await askName(`Rename “${r.title || "Untitled"}”`, r.title || "", "Rename", "title");
      if (name) await renameRecord(shell, r.id, name);
    },
  }, -1);
  shell.recordActions.add("shell", "move-to-folder", {
    label: (n) => (n === 1 ? "Move to folder…" : `Move ${n} items to folder…`),
    // Not for archived records: they come back where they were.
    applies: (r) => spaces.has(r.kind) && !r.read_only && !shell.records.isHidden(r),
    partial: true,
    run: (rs) => {
      const kinds = new Set(rs.map((r) => r.kind));
      if (kinds.size > 1) return toast("Notes and library items have their own folders: move them separately.");
      void spaceOf(rs[0]!.kind)!.moveRecords(rs);
    },
  });

  return {
    add(def) {
      spaces.set(def.kind, make(def));
    },
    render(kind: string, host: HTMLElement, params: Record<string, string>, ctx: PageContext) {
      const sp = spaceOf(kind);
      if (!sp) return () => {};
      return renderFiles(sp.fx, host, params, ctx);
    },
    tree,
    topMenu: (kind: string) => spaceOf(kind)?.topMenu() ?? [],
    newFolderIn: async (kind: string, parent: string) => void (await spaceOf(kind)?.newFolderIn(parent)),
    spaces: () => [...spaces.values()].map((s) => ({ kind: s.def.kind, title: s.def.title, page: s.def.page })),
    dropOnTop(kind: string): DropTarget {
      return {
        accepts: (p) => canMoveInto(shell, p, "", kind),
        drop: (p) => {
          const sp = spaceOf(kind);
          if (sp) void moveInto(shell, sp.store, p, "", sp.def.title);
        },
      };
    },
    async moveTo(rs: RecordInfo[]) {
      const sp = rs[0] ? spaceOf(rs[0].kind) : undefined;
      if (sp) await sp.moveRecords(rs);
    },
  };
}
