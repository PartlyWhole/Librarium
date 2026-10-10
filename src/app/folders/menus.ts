/** The context menus of folders, of several things at once, and of a space's top level. */
import { prompt } from "../../ui/dialog";
import { contextMenu, type MenuItem, type Point } from "../../ui/menu";
import { untracked } from "../../ui/signal";
import type { RecordInfo } from "../../types";
import { actionList, runAction } from "../actions";
import { recordActionsFor } from "../recordmenu";
import { router } from "../router";
import { showStatus } from "../status";
import { badFolderName, join, nameOf, uniqueName, within } from "./model";
import { deleteFolder, moveTo, newFolder, renameFolder } from "./ops";
import { contents, type Space } from "./spaces";

/** Shows a folder of a space (its top level for ""). */
export function goFolder(sp: Space, folder: string, newTab = false): void {
  router.go(sp.page, folder ? { folder } : {}, { newTab });
}

/** Asks for a name, then makes a folder inside `parent`. */
export async function newFolderIn(sp: Space, parent: string): Promise<void> {
  const c = untracked(() => contents(sp));
  const name = await prompt(parent ? `New folder in “${nameOf(parent)}”` : `New folder in ${sp.title}`, {
    value: uniqueName("untitled folder", (n) => c.has(join(parent, n))),
    label: "Folder name",
    action: "Make folder",
    check: badFolderName,
  });
  if (name && (await newFolder(sp, join(parent, name)))) showStatus(`Made the folder “${name}”.`);
}

/** Record actions for what is inside folders (Archive inside…), without moving. */
function insideActions(rs: RecordInfo[]): MenuItem[] {
  return recordActionsFor(rs)
    .filter((a) => !a.label.startsWith("Move "))
    .map((a) => ({ ...a, label: rs.length === 1 ? `${a.label} (the one item inside)` : `${a.label} inside` }));
}

/** New note, New board…: made in `folder` ("" for the top level). */
function createIn(sp: Space, folder: string, suffix: string): MenuItem[] {
  return sp.create
    .filter(([id]) => actionList().some((a) => a.id === id))
    .map(([id, label]) => ({ label: label + suffix, run: () => void runAction(id, { folder }) }));
}

/** A folder's entries, beyond Open and Rename. */
export function folderMenu(sp: Space, path: string): MenuItem[] {
  const c = untracked(() => contents(sp));
  const inside = insideActions(c.recordsUnder(path));
  return [
    ...createIn(sp, path, " inside"),
    { label: "New folder inside…", run: () => void newFolderIn(sp, path) },
    { label: "Move to…", run: () => void moveTo(sp, [], [path]) },
    ...(inside.length ? ["separator" as const, ...inside] : []),
    "separator",
    // Empty, it goes at once; with things in it, they're archived first (after asking).
    { label: c.entries(path).length ? "Delete folder…" : "Delete folder", destructive: true, run: () => void deleteFolder(sp, path) },
  ];
}

/** Several records and folders together. */
export function manyMenu(sp: Space, rs: RecordInfo[], folders: string[]): MenuItem[] {
  const c = untracked(() => contents(sp));
  const acts = recordActionsFor([...rs, ...folders.flatMap((f) => c.recordsUnder(f))]).filter((a) => !a.label.startsWith("Move "));
  return [{ label: `Move ${rs.length + folders.length} items to…`, run: () => void moveTo(sp, rs, folders) }, ...(acts.length ? ["separator" as const, ...acts] : [])];
}

/** A folder's own menu (in the sidebar), with Rename… through a dialog. */
export function showFolderMenu(sp: Space, path: string, at: Point): void {
  const rename = async () => {
    const name = await prompt(`Rename “${nameOf(path)}”`, { value: nameOf(path), label: "Folder name", action: "Rename", check: badFolderName });
    const to = name && (await renameFolder(sp, path, name));
    const r = router.current.peek();
    // Keep showing it (or what's inside it) under its new name.
    if (to && r.page === sp.page && within(r.params.folder ?? "", path)) goFolder(sp, to + (r.params.folder ?? "").slice(path.length));
  };
  contextMenu([
    { label: "Open", run: () => goFolder(sp, path) },
    { label: "Open in new tab", run: () => goFolder(sp, path, true) },
    { label: "Rename…", run: () => void rename() },
    "separator",
    ...folderMenu(sp, path),
  ], at, nameOf(path));
}

/** A space's top level (its sidebar heading). */
export function topMenu(sp: Space): MenuItem[] {
  return [
    { label: `Open ${sp.title}`, run: () => goFolder(sp, "") },
    { label: "Open in new tab", run: () => goFolder(sp, "", true) },
    "separator",
    ...createIn(sp, "", ""),
    { label: "New folder…", run: () => void newFolderIn(sp, "") },
  ];
}
