/**
 * Adding to the library: Add to library… (the open dialog) and files dropped anywhere on the
 * window go into the Library folder being viewed; a single import opens the item. Also the
 * record actions for items: Move to the Library (attachments) and Remove older snapshots….
 */
import { call, onFileDrop, pickFiles } from "../backend";
import { defineAction } from "../app/actions";
import { moveInto } from "../app/folders/ops";
import { folderOf } from "../app/folders";
import { spaceOf } from "../app/folders/spaces";
import { isOpen } from "../app/library";
import { here } from "../app/pages";
import { formatOf, isArchived, openRecord, putRecord } from "../app/records";
import { addRecordAction } from "../app/recordmenu";
import { showStatus } from "../app/status";
import { editorAt } from "../notes/attach";
import { errorText } from "../ui/dom";
import { count } from "../ui/format";
import { signal, effect } from "../ui/signal";
import { toast } from "../ui/toast";
import type { ImportResult, RecordInfo } from "../types";
import { removeSnapshots } from "./snapshots";
import { Plus } from "lucide";
import "./library.css";

export { removeSnapshots } from "./snapshots";

const EXTENSIONS = ["pdf", "epub", "png", "jpg", "jpeg", "gif", "webp", "heic", "tif", "tiff"];
const ATTACHMENTS = "Attachments";

/**
 * Marks an element that takes file drops itself (a board's canvas): drops over it are left to
 * it. Boards set this attribute on their canvas.
 */
export const OWN_DROPS = "data-own-drops";

/** Whether a drop at this point belongs to something else (a note's editor, a board). */
export function dropHandledElsewhere(at: { x: number; y: number }): boolean {
  const editor = editorAt(at);
  if (editor && !editor.state.readOnly) return true;
  const el = document.elementFromPoint(at.x, at.y);
  return !!el?.closest(`[${OWN_DROPS}], .excalidraw`);
}

/** The Library folder being viewed ("" for its top level, or when none is). */
export function libraryHere(): string {
  const at = here.peek();
  return at?.kind === "item" ? at.folder : "";
}

/** Adds files into the viewed Library folder; refused ones get a toast. */
export async function importPaths(paths: string[]): Promise<void> {
  if (!paths.length) return;
  showStatus(`Adding ${count(paths.length, "file")}…`, 0);
  try {
    const r = await call<ImportResult>("library.import", { paths, folder: libraryHere() || null });
    for (const w of r.imported) putRecord(w.info);
    showStatus(r.imported.length ? `Added ${r.imported.length === 1 ? `“${r.imported[0]!.info.title}”` : count(r.imported.length, "item")} to the library.` : "");
    for (const f of r.failed) toast(f.error);
    if (r.imported.length === 1) openRecord(r.imported[0]!.info.id);
  } catch (e) {
    showStatus("");
    toast(errorText(e));
  }
}

defineAction({
  id: "library.add",
  title: "Add to library…",
  when: isOpen,
  menu: { name: "file", group: 1.3 },
  icon: Plus,
  run: async () => importPaths(await pickFiles("Add to library", EXTENSIONS)),
});

// Files dropped anywhere else on the window are added; the window shows a frame meanwhile.
const dropping = signal(false);
onFileDrop((paths, at) => {
  if (isOpen() && !dropHandledElsewhere(at)) void importPaths(paths);
}, (over) => dropping.set(over && isOpen()));
effect(() => document.body.classList.toggle("dropping", dropping()));

// ---- Record actions ------------------------------------------------------------------------

const isAttachment = (r: RecordInfo) => {
  const f = folderOf(r);
  return r.kind === "item" && (f === ATTACHMENTS || f.startsWith(`${ATTACHMENTS}/`));
};
const snapshotCount = (r: RecordInfo) => (Array.isArray(r.fields["library.snapshots"]) ? r.fields["library.snapshots"].length : 0);

// An attachment made an item of its own, at the Library's top; notes showing it keep showing it.
addRecordAction({
  id: "move-to-library",
  label: (n) => (n === 1 ? "Move to the Library" : `Move ${n} to the Library`),
  applies: (r) => isAttachment(r) && !r.read_only && !isArchived(r),
  partial: true,
  run: (rs) => moveInto(spaceOf("item"), { kind: "item", records: rs.map((r) => r.id), folders: [] }, ""),
});

addRecordAction({
  id: "remove-snapshots",
  label: (n) => (n === 1 ? "Remove older snapshots…" : `Remove older snapshots of ${n} pages…`),
  applies: (r) => r.kind === "item" && formatOf(r) === "web" && snapshotCount(r) > 1 && !r.read_only,
  partial: true,
  run: (rs) => void removeSnapshots(rs.map((r) => ({ id: r.id, snapshots: null }))),
});
