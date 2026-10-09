/** What can be done to folders and to the records in them, each offering Undo where it can. */
import { call } from "../../backend";
import { archiveRecords } from "../../archive";
import { comboboxDialog } from "../../ui/combobox";
import { ask } from "../../ui/dialog";
import type { DragPayload } from "../../ui/dnd";
import { errorText, h } from "../../ui/dom";
import { count } from "../../ui/format";
import { toast } from "../../ui/toast";
import { untracked } from "../../ui/signal";
import type { FolderMoved, MovedRecords, RecordInfo, Written } from "../../types";
import { getRecord, putRecord } from "../records";
import { showStatus } from "../status";
import { done } from "../undo";
import { folderOf, join, keyOf, nameOf, parentOf, placed, within } from "./model";
import { contents, inSpace, orderOf, refreshFolders, saveOrder, sorted, type Space } from "./spaces";
import { Folder, Home } from "lucide";

const quoted = (sp: Space, path: string) => `“${path ? nameOf(path) : sp.title}”`;
const moveFolder = (sp: Space, from: string, to: string) => call<FolderMoved>("folders.move", { kind: sp.kind, from, to });
async function moveRecords(ids: string[], folder: string): Promise<MovedRecords> {
  const r = await call<MovedRecords>("records.move", { ids, folder: folder || null });
  for (const w of r.moved) putRecord(w.info);
  return r;
}

/** Whether a drag (or a choice of folder) can go into `dest`. */
export function canMoveInto(p: DragPayload, dest: string, sp: Space): boolean {
  if (p.kind !== sp.kind || p.folders.some((f) => within(dest, f) || parentOf(f) === dest)) return false;
  const rs = p.records.map((id) => untracked(() => getRecord(id)));
  if (rs.some((r) => !r || !inSpace(r.kind, sp))) return false;
  // Something has to actually move.
  return p.folders.length > 0 || rs.some((r) => r && folderOf(r) !== dest);
}

/** Whether a drag can be placed among the things in `folder` (moving there if it must). */
export function canPlaceIn(p: DragPayload, folder: string, sp: Space): boolean {
  if (p.kind !== sp.kind || p.folders.some((f) => within(folder, f))) return false;
  return p.records.every((id) => {
    const r = untracked(() => getRecord(id));
    return !!r && inSpace(r.kind, sp);
  });
}

/** Moves records and folders into `dest`, offering Undo. */
export async function moveInto(sp: Space, p: DragPayload, dest: string): Promise<void> {
  const rs = p.records.map((id) => untracked(() => getRecord(id))).filter((r): r is RecordInfo => !!r && folderOf(r) !== dest);
  const from = new Map(rs.map((r) => [r.id, folderOf(r)]));
  const folders = p.folders.filter((f) => parentOf(f) !== dest && !within(dest, f));
  const movedFolders: { from: string; to: string }[] = [];
  try {
    for (const f of folders) {
      try {
        movedFolders.push({ from: f, to: (await moveFolder(sp, f, join(dest, nameOf(f)))).path });
      } catch (e) {
        toast(errorText(e));
      }
    }
    let moved: Written[] = [];
    if (rs.length) {
      const r = await moveRecords(rs.map((x) => x.id), dest);
      moved = r.moved;
      for (const f of r.failed) toast(`${getRecord(f.id)?.title || "An item"}: ${f.error}`);
    }
    await refreshFolders();
    const n = moved.length + movedFolders.length;
    if (!n) return;
    const what = n === 1 ? `“${moved[0]?.info.title ?? nameOf(movedFolders[0]!.to)}”` : count(n, "item");
    done(`Moved ${what} to ${quoted(sp, dest)}.`, {
      label: `moving ${what}`,
      undo: async () => {
        for (const f of [...movedFolders].reverse()) await moveFolder(sp, f.to, f.from);
        const back = Map.groupBy(moved, (w) => from.get(w.info.id) ?? "");
        for (const [f, ws] of back) await moveRecords(ws.map((w) => w.info.id), f);
        await refreshFolders();
      },
      // A folder may land under another name if one took its own meanwhile.
      redo: async () => {
        for (const f of movedFolders) f.to = (await moveFolder(sp, f.from, join(dest, nameOf(f.from)))).path;
        if (moved.length) await moveRecords(moved.map((w) => w.info.id), dest);
        await refreshFolders();
      },
    });
  } catch (e) {
    toast(errorText(e));
    await refreshFolders();
  }
}

/**
 * Places dragged things just before or after an entry of `folder` (moving them there first if
 * they are elsewhere), and from then on shows the space as arranged by hand.
 */
export async function place(sp: Space, folder: string, p: DragPayload, anchor: string, where: "before" | "after"): Promise<void> {
  const outside: DragPayload = {
    kind: sp.kind,
    records: p.records.filter((id) => {
      const r = getRecord(id);
      return r && folderOf(r) !== folder;
    }),
    folders: p.folders.filter((f) => parentOf(f) !== folder),
  };
  const moving = outside.records.length + outside.folders.length > 0;
  if (moving) await moveInto(sp, outside, folder);
  const keys = [...p.records, ...p.folders.map((f) => `folder:${nameOf(f)}`)];
  const next = placed(untracked(() => sorted(sp, folder)).map(keyOf), keys, anchor, where);
  const prevOrder = untracked(() => orderOf(sp, folder));
  const prevSort = sp.sort.peek();
  try {
    await saveOrder(sp, folder, next);
  } catch (e) {
    return toast(errorText(e));
  }
  if (prevSort.key !== "manual") {
    sp.sort.set({ key: "manual", dir: 1 });
    showStatus("Now arranged by hand. Sort by name, kind or date to go back.", 8000);
  }
  // A move already offered its own Undo.
  if (moving) return;
  done(keys.length === 1 ? "Moved it there." : `Moved ${keys.length} items there.`, {
    label: "arranging",
    undo: async () => {
      await saveOrder(sp, folder, prevOrder);
      sp.sort.set(prevSort);
    },
    redo: async () => {
      await saveOrder(sp, folder, next);
      sp.sort.set({ key: "manual", dir: 1 });
    },
  });
}

/** Renames a folder (a move within its parent); resolves with its new path. */
export async function renameFolder(sp: Space, path: string, name: string): Promise<string | null> {
  const to = join(parentOf(path), name.trim());
  if (to === path) return path;
  try {
    let now = (await moveFolder(sp, path, to)).path;
    await refreshFolders();
    done(`Renamed “${nameOf(path)}” to “${nameOf(now)}”.`, {
      label: "renaming the folder",
      undo: async () => (await moveFolder(sp, now, path), await refreshFolders()),
      redo: async () => ((now = (await moveFolder(sp, path, to)).path), await refreshFolders()),
    });
    return now;
  } catch (e) {
    toast(errorText(e));
    return null;
  }
}

/** Renames a record (its file name follows its title). */
export async function renameRecord(id: string, title: string): Promise<void> {
  const r = getRecord(id);
  const before = r?.title ?? "";
  const t = title.trim();
  if (!r || !t || t === before) return;
  try {
    let version = (await relocate({ id, title: t })).version;
    const retitle = async (title: string) => void (version = (await relocate({ id, title, base_version: version })).version);
    done(`Renamed to “${t}”.`, { label: `rename to “${t}”`, undo: () => retitle(before), redo: () => retitle(t) });
  } catch (e) {
    toast(errorText(e));
  }
}

async function relocate(params: { id: string; title: string; base_version?: string }): Promise<RecordInfo> {
  const w = await call<Written>("records.relocate", params);
  putRecord(w.info);
  return w.info;
}

/** Makes a folder; resolves with its path. */
export async function newFolder(sp: Space, path: string): Promise<string | null> {
  try {
    const r = await call<FolderMoved>("folders.create", { kind: sp.kind, path });
    await refreshFolders();
    return r.path;
  } catch (e) {
    toast(errorText(e));
    return null;
  }
}

/**
 * Deletes a folder. An empty one goes at once. One with things in it is confirmed, then its
 * records are archived and its empty folders removed; the folder stays on disk with the
 * archived records (they keep their place) and comes back if one is restored. One Undo puts
 * it all back.
 */
export async function deleteFolder(sp: Space, path: string): Promise<void> {
  const c = untracked(() => contents(sp));
  const rs = c.recordsUnder(path);
  const removeEmpty = async (folders: string[]) => {
    const removed: string[] = [];
    for (const f of folders.sort((a, b) => b.split("/").length - a.split("/").length)) {
      await call("folders.remove", { kind: sp.kind, path: f }).then(() => removed.push(f), () => {});
    }
    return removed;
  };
  const restore = async (folders: string[]) => {
    for (const f of [...folders].reverse()) await call("folders.create", { kind: sp.kind, path: f });
  };
  if (!rs.length) {
    const removed = await removeEmpty([...c.folders.filter((f) => f.startsWith(`${path}/`)), path]);
    if (!removed.includes(path)) return toast("The folder couldn’t be removed.");
    await refreshFolders();
    done(`Removed the folder “${nameOf(path)}”.`, {
      label: "removing the folder",
      undo: async () => (await restore(removed), await refreshFolders()),
      redo: async () => (await removeEmpty([...removed]), await refreshFolders()),
    });
    return;
  }
  const locked = rs.find((r) => r.read_only);
  if (locked) return toast(`“${locked.title || "An item"}” can’t be archived, so the folder was left as it is.`);
  const n = rs.length;
  const ok = await ask(`Delete “${nameOf(path)}”?`,
    h("p", null, `The ${count(n, "item")} inside ${n === 1 ? "goes" : "go"} to the Archive, where you can restore ${n === 1 ? "it (it comes" : "them (they come"} back in this folder) or delete ${n === 1 ? "it" : "them"} for good.`),
    [{ label: "Cancel", value: false }, { label: `Archive ${count(n, "item")} and delete`, value: true, primary: true }]);
  if (!ok) return;
  const inside = c.folders.filter((f) => f.startsWith(`${path}/`));
  let removed = await removeEmpty([...inside]);
  const step = await archiveRecords(rs.map((r) => r.id));
  await refreshFolders();
  if (!step.archived) return;
  done(`Deleted “${nameOf(path)}”: ${count(step.archived, "item")} archived.`, {
    label: `deleting the folder “${nameOf(path)}”`,
    undo: async () => (await step.undo(), await restore(removed), await refreshFolders()),
    redo: async () => ((removed = await removeEmpty([...inside])), await step.redo(), await refreshFolders()),
  });
}

/** Asks which folder to move things into: an existing one, or a new one typed in. */
export function chooseFolder(sp: Space, label: string, exclude: (f: string) => boolean): Promise<string | null> {
  return new Promise((resolve) => {
    let picked = false;
    const TOP = "\u0000";
    const choices = [
      ...(exclude("") ? [] : [{ id: TOP, label: sp.title, detail: "Top level", icon: Home }]),
      ...untracked(() => contents(sp)).folders.filter((f) => !exclude(f)).map((f) => ({ id: f, label: nameOf(f), detail: parentOf(f) ? parentOf(f).replaceAll("/", " › ") : undefined, icon: Folder })),
    ];
    const m = comboboxDialog({
      label,
      placeholder: "Type a folder’s name (new or existing)",
      emptyText: "Press Return to make this folder.",
      choices,
      filter: (cs, q) => {
        const t = q.trim().replace(/^\/+|\/+$/g, "");
        const hits = cs.filter((c) => `${c.label} ${c.detail ?? ""} ${c.id}`.toLowerCase().includes(t.toLowerCase()));
        const fresh = t && !cs.some((c) => c.id === t) && !t.split("/").some((p) => !p.trim() || p.startsWith("."));
        return fresh ? [...hits, { id: t, label: `New folder “${t}”`, icon: Folder }] : hits;
      },
      onPick: (c) => {
        picked = true;
        resolve(c.id === TOP ? "" : c.id);
      },
    });
    m.el.addEventListener("close", () => !picked && resolve(null));
  });
}

/** Move to folder…: asks where, then moves records and folders there. */
export async function moveTo(sp: Space, rs: RecordInfo[], folders: string[] = []): Promise<void> {
  const n = rs.length + folders.length;
  const label = n === 1 ? `Move “${rs[0]?.title ?? nameOf(folders[0]!)}” to` : `Move ${n} items to`;
  const dest = await chooseFolder(sp, label, (f) => folders.some((p) => within(f, p)) || (!rs.length && folders.every((p) => parentOf(p) === f)));
  if (dest === null) return;
  const p = { kind: sp.kind, records: rs.map((r) => r.id), folders };
  if (!canMoveInto(p, dest, sp)) return toast("They’re already there.");
  await moveInto(sp, p, dest);
}
