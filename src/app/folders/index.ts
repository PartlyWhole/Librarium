/**
 * Folders: Notes and Library each have their own, browsed as in Finder. This gives each space
 * its page, its part of the sidebar tree (folders and records, each folder a place to drop
 * things on), and Rename… and Move to folder… wherever records have a menu.
 */
import { prompt } from "../../ui/dialog";
import type { DropTarget } from "../../ui/dnd";
import { zone } from "../../ui/dnd";
import { untracked } from "../../ui/signal";
import { toast } from "../../ui/toast";
import type { TreeNode } from "../../ui/tree";
import type { RecordInfo } from "../../types";
import { defineAction } from "../actions";
import { isOpen } from "../library";
import { here, pages } from "../pages";
import { getRecord, isArchived, openRecord, recordIcon } from "../records";
import { addRecordAction } from "../recordmenu";
import { router } from "../router";
import { folderOf } from "./model";
import { goFolder, showFolderMenu } from "./menus";
import { canMoveInto, canPlaceIn, moveInto, moveTo, place, renameRecord } from "./ops";
import { sorted, spaceFor, spaceOf, type Space } from "./spaces";
import { arriveWith, makeFolderHere, renderFolder } from "./view";
import { Files, Folder, FolderOpen, Library } from "lucide";

export { SPACES, spaceFor, type Space } from "./spaces";
export { folderOf } from "./model";
export { goFolder, newFolderIn, topMenu } from "./menus";

pages.notes = { title: "Notes", icon: Files, render: (host, params, ctx) => renderFolder(spaceOf("note"), host, params, ctx) };
pages.library = { title: "Library", icon: Library, render: (host, params, ctx) => renderFolder(spaceOf("item"), host, params, ctx) };

const childrenOf: ((r: RecordInfo) => TreeNode[])[] = [];
/** What a record holds, shown folded under it in the sidebar (an item's captures). */
export function addRecordChildren(fn: (r: RecordInfo) => TreeNode[]): void {
  childrenOf.push(fn);
}

/** Drops on a space's top level (its sidebar heading). */
export function dropOnTop(sp: Space): DropTarget {
  return { accepts: (p) => canMoveInto(p, "", sp), drop: (p) => void moveInto(sp, p, "") };
}

/** A space's sidebar tree: its folders and records (reads signals). */
export function spaceTree(sp: Space): TreeNode[] {
  const r = router.current();
  const at = r.page === sp.page ? r.params.folder ?? "" : null;
  const entries = (path: string): TreeNode[] =>
    sorted(sp, path).map((e): TreeNode => {
      if (e.type === "record") {
        const kids = childrenOf.flatMap((fn) => fn(e.record));
        return {
          id: e.id,
          label: e.name,
          icon: recordIcon(e.record),
          current: r.params.id === e.id,
          onActivate: () => openRecord(e.id),
          onOpenNew: () => openRecord(e.id, {}, { newTab: true }),
          drag: () => ({ records: [e.id], folders: [], kind: sp.kind }),
          // Dropped above or below it, things are arranged beside it.
          drop: {
            accepts: (p) => canPlaceIn(p, path, sp) && !p.records.includes(e.id),
            where: (_p, x, y, el) => zone(el, x, y, { into: false }),
            drop: (p, w) => void (w !== "into" && place(sp, path, p, e.id, w)),
          },
          ...(kids.length ? { children: kids, startCollapsed: true } : {}),
        };
      }
      const f = e.path;
      return {
        id: `folder:${sp.kind}:${f}`,
        label: e.name,
        icon: at === f ? FolderOpen : Folder,
        current: at === f,
        children: entries(f),
        onActivate: () => goFolder(sp, f),
        onOpenNew: () => goFolder(sp, f, true),
        onContext: (p) => showFolderMenu(sp, f, p),
        drag: () => ({ records: [], folders: [f], kind: sp.kind }),
        // Its top and bottom edges place things beside it; the middle moves them in.
        drop: {
          accepts: (p) => canMoveInto(p, f, sp) || canPlaceIn(p, path, sp),
          where: (p, x, y, el) => {
            if (p.folders.includes(f)) return null;
            const w = zone(el, x, y, { into: canMoveInto(p, f, sp) });
            return w === "into" || canPlaceIn(p, path, sp) ? w : null;
          },
          drop: (p, w) => void (w === "into" ? moveInto(sp, p, f) : place(sp, path, p, `folder:${e.name}`, w)),
        },
      };
    });
  return entries("");
}

// ---- Actions ----------------------------------------------------------------------------

/** The record shown, if it is kept in folders and can be moved. */
const shownRecord = () => {
  const r = getRecord(router.current().params.id);
  return r && spaceFor(r.kind) && !r.read_only ? r : undefined;
};

defineAction({
  id: "folders.new",
  title: "New folder",
  keys: ["Mod+Shift+N"],
  when: isOpen,
  menu: { name: "file", group: 0.4 },
  icon: Folder,
  run: () => {
    if (makeFolderHere()) return;
    // Elsewhere: in the folder last looked at (or Notes), on its page.
    const h = here.peek();
    goFolder(spaceOf(h?.kind ?? "note"), h?.folder ?? "");
    setTimeout(makeFolderHere, 0);
  },
});

defineAction({
  id: "folders.moveTo",
  title: "Move to folder…",
  when: () => !!shownRecord(),
  menu: { name: "file", group: 2.1 },
  run: () => {
    const r = untracked(shownRecord);
    if (r) void moveTo(spaceFor(r.kind)!, [r]);
  },
});

defineAction({
  id: "folders.showInFolder",
  title: "Show in its folder",
  when: () => !!shownRecord(),
  menu: { name: "file", group: 2.2 },
  run: () => {
    const r = untracked(shownRecord);
    if (!r) return;
    // It lands with the record selected.
    arriveWith(folderOf(r), r.id);
    goFolder(spaceFor(r.kind)!, folderOf(r));
  },
});

const movable = (r: RecordInfo) => !!spaceFor(r.kind) && !r.read_only && !isArchived(r);

addRecordAction({
  id: "rename",
  label: "Rename…",
  single: true,
  applies: movable,
  run: async ([r]) => {
    const name = r && (await prompt(`Rename “${r.title || "Untitled"}”`, { value: r.title, label: "Title", action: "Rename" }));
    if (r && name) await renameRecord(r.id, name);
  },
});

addRecordAction({
  id: "move",
  label: (n) => (n === 1 ? "Move to folder…" : `Move ${n} items to folder…`),
  // Not archived records: they come back where they were.
  applies: movable,
  partial: true,
  run: (rs) => {
    const sp = spaceFor(rs[0]!.kind)!;
    if (rs.some((r) => spaceFor(r.kind) !== sp)) return toast("Notes and library items have their own folders: move them separately.");
    void moveTo(sp, rs);
  },
});
