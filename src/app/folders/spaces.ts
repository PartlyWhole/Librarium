/**
 * The two folder spaces: Notes (notes and boards share its folders) and Library (items). Each
 * has its folders and their arrangement (from `folders.list`), what they hold, and its page's
 * sort and view.
 */
import { call } from "../../backend";
import type { IconNode } from "../../ui/icon";
import { effect, signal, untracked, type Signal } from "../../ui/signal";
import type { FolderSpace, RecordInfo } from "../../types";
import { isOpen } from "../library";
import { pref } from "../prefs";
import { isArchived, kindName, records } from "../records";
import { Contents, sortEntries, type Entry, type Sort } from "./model";
import { FilePlus, Globe, Plus } from "lucide";

export interface Space {
  /** The kind the space is named for (its folders are under that kind's top folder). */
  kind: string;
  /** The page showing one of its folders (params: `{folder}`). */
  page: string;
  /** Its name, also its top level's. */
  title: string;
  /** What the sidebar says while it is empty. */
  emptyText: string;
  /** What its page says while its top level is empty. */
  pageEmpty: string;
  /** Header buttons for its page: actions other features define, shown once they exist. */
  header: [action: string, icon: IconNode, label: string][];
  sort: Signal<Sort>;
  view: Signal<"list" | "icons">;
}

const space = (kind: string, page: string, title: string, emptyText: string, pageEmpty: string, header: Space["header"]): Space => ({
  kind, page, title, emptyText, pageEmpty, header,
  sort: pref<Sort>(`folders.sort.${kind}`, { key: "name", dir: 1 }),
  view: pref<"list" | "icons">(`folders.view.${kind}`, "list"),
});

export const SPACES: Space[] = [
  space("note", "notes", "Notes", "No notes yet.", "No notes yet.", [["notes.new", FilePlus, "New note"]]),
  space("item", "library", "Library", "No library items yet.", "No library items yet. Add PDFs, images or EPUBs (or drop them on the window), or save web pages.", [
    ["library.savePages", Globe, "Save web pages"],
    ["library.add", Plus, "Add to library"],
  ]),
];

const listed = signal<FolderSpace[]>([]);

export async function refreshFolders(): Promise<void> {
  try {
    listed.set((await call<{ spaces: FolderSpace[] }>("folders.list")).spaces);
  } catch {
    /* no library open */
  }
}
effect(() => (isOpen() ? void refreshFolders() : listed.set([])));
// Folders made or removed in Finder show up when the window comes back.
window.addEventListener("focus", () => isOpen() && void refreshFolders());

const mine = (kind: string) => listed().find((x) => x.kind === kind);

/** Whether records of a kind are kept in a space (boards: in Notes). */
export const inSpace = (recordKind: string, sp: Space): boolean => (mine(sp.kind)?.kinds ?? [sp.kind]).includes(recordKind);

/** The space a record of this kind is kept in, if any. */
export function spaceFor(recordKind: string): Space | undefined {
  return SPACES.find((sp) => sp.kind === recordKind) ?? SPACES.find((sp) => untracked(() => inSpace(recordKind, sp)));
}

export const spaceOf = (kind: string): Space => SPACES.find((s) => s.kind === kind)!;

/** The arrangement of one folder (keys), as the user left it. */
export const orderOf = (sp: Space, folder: string): string[] => mine(sp.kind)?.order[folder] ?? [];

/** Saves an arrangement, and shows it at once. */
export async function saveOrder(sp: Space, folder: string, order: string[]): Promise<void> {
  await call("folders.setOrder", { kind: sp.kind, path: folder, order });
  listed.set(listed.peek().map((x) => (x.kind === sp.kind ? { ...x, order: { ...x.order, [folder]: order } } : x)));
}

const memo = new Map<string, { f: unknown; m: unknown; c: Contents }>();
/** What a space's folders hold (reads signals). */
export function contents(sp: Space): Contents {
  const l = mine(sp.kind);
  const m = records();
  const known = memo.get(sp.kind);
  if (known && known.f === l && known.m === m) return known.c;
  const c = new Contents(l?.folders ?? [], [...m.values()].filter((r: RecordInfo) => inSpace(r.kind, sp)), isArchived);
  memo.set(sp.kind, { f: l, m, c });
  return c;
}

/** A folder's entries as its page and the sidebar show them (reads signals). */
export function sorted(sp: Space, folder: string): Entry[] {
  return sortEntries(contents(sp).entries(folder), sp.sort(), kindName, orderOf(sp, folder));
}
