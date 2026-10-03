/** What can be done to folders and to the records in them, each with an Undo where it can. */
import { call } from "../../backend";
import { count } from "../../kit/format";
import { toast } from "../../kit/toast";
import { comboboxDialog } from "../../kit/combobox";
import type { DragPayload } from "../../kit/dnd";
import type { ShellApi } from "../../shell/api";
import type { FolderMoved } from "../../generated/FolderMoved";
import type { MovedRecords } from "../../generated/MovedRecords";
import type { Written } from "../../generated/Written";
import { Folder, Home } from "lucide";
import { folderOf, join, nameOf, parentOf, within } from "./model";

export const message = (e: unknown) => String((e as { message?: string })?.message ?? e);

/** Where the folders' list is kept current. */
export interface FolderStore {
  list(): string[];
  kinds(): string[];
  /** The arrangement of one folder (reads a signal). */
  order(folder: string): string[];
  refresh(): Promise<void>;
}

const quoted = (path: string, root: string) => `“${path ? nameOf(path) : root}”`;

/** Whether a drag (or a choice of folder) can go into `dest`. */
export function canMoveInto(shell: ShellApi, p: DragPayload, dest: string, kinds: string[]): boolean {
  if (p.folders.some((f) => within(dest, f) || parentOf(f) === dest)) return false;
  const rs = p.records.map((id) => shell.records.get(id));
  if (rs.some((r) => !r || !kinds.includes(r.kind))) return false;
  // Something has to actually move.
  return p.folders.length > 0 || rs.some((r) => r && folderOf(r) !== dest);
}

/** Whether a drag can be placed among the things in `folder` (moving there if it must). */
export function canPlaceIn(shell: ShellApi, p: DragPayload, folder: string, kinds: string[]): boolean {
  if (p.folders.some((f) => within(folder, f))) return false;
  return p.records.every((id) => {
    const r = shell.records.get(id);
    return !!r && kinds.includes(r.kind);
  });
}

/** Moves records and folders into `dest`, offering Undo. */
export async function moveInto(shell: ShellApi, store: FolderStore, p: DragPayload, dest: string, root: string): Promise<void> {
  const records = p.records.map((id) => shell.records.get(id)).filter((r): r is NonNullable<typeof r> => !!r && folderOf(r) !== dest);
  const from = new Map(records.map((r) => [r.id, folderOf(r)]));
  const folders = p.folders.filter((f) => parentOf(f) !== dest && !within(dest, f));
  const movedFolders: { from: string; to: string }[] = [];
  const failures: string[] = [];
  try {
    for (const f of folders) {
      try {
        const r = await call<FolderMoved>("folders.move", { from: f, to: join(dest, nameOf(f)) });
        movedFolders.push({ from: f, to: r.path });
      } catch (e) {
        failures.push(message(e));
      }
    }
    let moved: Written[] = [];
    if (records.length) {
      const r = await call<MovedRecords>("records.move", { ids: records.map((x) => x.id), folder: dest || null });
      moved = r.moved;
      for (const w of r.moved) shell.records.put(w.info, w.seq);
      for (const f of r.failed) failures.push(`${shell.records.get(f.id)?.title || "An item"}: ${f.error}`);
    }
    await store.refresh();
    const n = moved.length + movedFolders.length;
    for (const f of failures) toast(f);
    if (!n) return;
    const what = n === 1 ? `“${moved[0]?.info.title ?? nameOf(movedFolders[0]!.to)}”` : count(n, "item");
    shell.undo.done(`Moved ${what} to ${quoted(dest, root)}.`, {
      label: `moving ${what}`,
      undo: async () => {
        for (const f of [...movedFolders].reverse()) await call("folders.move", { from: f.to, to: f.from });
        const back = new Map<string, string[]>();
        for (const w of moved) {
          const f = from.get(w.info.id) ?? "";
          back.set(f, [...(back.get(f) ?? []), w.info.id]);
        }
        for (const [f, ids] of back) {
          const r = await call<MovedRecords>("records.move", { ids, folder: f || null });
          for (const w of r.moved) shell.records.put(w.info, w.seq);
        }
        await store.refresh();
      },
    });
  } catch (e) {
    toast(message(e));
    await store.refresh();
  }
}

/** Renames a folder (a move within its parent). */
export async function renameFolder(shell: ShellApi, store: FolderStore, path: string, name: string): Promise<string | null> {
  const to = join(parentOf(path), name.trim());
  if (to === path) return path;
  try {
    const r = await call<FolderMoved>("folders.move", { from: path, to });
    await store.refresh();
    shell.undo.done(`Renamed “${nameOf(path)}” to “${nameOf(r.path)}”.`, {
      label: "renaming the folder",
      undo: async () => {
        await call("folders.move", { from: r.path, to: path });
        await store.refresh();
      },
    });
    return r.path;
  } catch (e) {
    toast(message(e));
    return null;
  }
}

/** Renames a record (its file name follows its title). */
export async function renameRecord(shell: ShellApi, id: string, title: string): Promise<void> {
  const r = shell.records.get(id);
  const before = r?.title ?? "";
  const t = title.trim();
  if (!r || !t || t === before) return;
  try {
    const w = await call<Written>("records.relocate", { id, title: t });
    shell.records.put(w.info, w.seq);
    shell.undo.done(`Renamed to “${t}”.`, {
      label: "renaming",
      undo: async () => {
        const back = await call<Written>("records.relocate", { id, title: before, base_version: w.info.version });
        shell.records.put(back.info, back.seq);
      },
    });
  } catch (e) {
    toast(message(e));
  }
}

/** Makes a folder; returns its path. */
export async function newFolder(store: FolderStore, path: string): Promise<string | null> {
  try {
    const r = await call<FolderMoved>("folders.create", { path });
    await store.refresh();
    return r.path;
  } catch (e) {
    toast(message(e));
    return null;
  }
}

/** Removes an empty folder, offering Undo. */
export async function removeFolder(shell: ShellApi, store: FolderStore, path: string): Promise<boolean> {
  try {
    await call("folders.remove", { path });
    await store.refresh();
    shell.undo.done(`Removed the folder “${nameOf(path)}”.`, {
      label: "removing the folder",
      undo: async () => {
        await call("folders.create", { path });
        await store.refresh();
      },
    });
    return true;
  } catch (e) {
    toast(message(e));
    return false;
  }
}

/** Asks which folder to move things into (an existing one, or a new one typed in). */
export function pickFolder(store: FolderStore, o: { label: string; root: string; exclude?: (f: string) => boolean }): Promise<string | null> {
  return new Promise((resolve) => {
    let picked = false;
    const choices = [
      { id: "\u0000", label: o.root, detail: "Top level", icon: Home },
      ...store.list().filter((f) => !o.exclude?.(f)).map((f) => ({ id: f, label: nameOf(f), detail: parentOf(f) ? parentOf(f).replaceAll("/", " › ") : undefined, icon: Folder })),
    ].filter((c) => c.id !== "\u0000" || !o.exclude?.(""));
    const m = comboboxDialog({
      label: o.label,
      placeholder: "Type a folder’s name (new or existing)",
      emptyText: "Press Return to make this folder.",
      choices,
      filter: (cs, q) => {
        const t = q.trim().replace(/^\/+|\/+$/g, "");
        const ql = t.toLowerCase();
        const hits = cs.filter((c) => `${c.label} ${c.detail ?? ""} ${c.id}`.toLowerCase().includes(ql));
        const exists = cs.some((c) => c.id === t);
        return t && !exists && !t.split("/").some((p) => !p.trim() || p.startsWith(".")) ? [...hits, { id: t, label: `New folder “${t}”`, icon: Folder }] : hits;
      },
      onPick: (c) => {
        picked = true;
        resolve(c.id === "\u0000" ? "" : c.id);
      },
    });
    m.el.addEventListener("close", () => {
      if (!picked) resolve(null);
    });
  });
}
