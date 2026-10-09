/**
 * One space's folders as the interface sees them (notes and library items each have their
 * own), with what each folder holds, and how entries sort and are arranged.
 */
import type { RecordInfo } from "../../types";

/** A record's folder inside its space's top folder ("" at the top level). */
export function folderOf(r: RecordInfo): string {
  const parts = r.path.split("/").slice(1);
  return parts.slice(0, parts.at(-1) === "record.json" ? -2 : -1).join("/");
}

export function parentOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}

export function nameOf(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

export function join(parent: string, name: string): string {
  return parent ? `${parent}/${name}` : name;
}

/** Whether `path` is `folder` or inside it. */
export function within(path: string, folder: string): boolean {
  return folder === "" || path === folder || path.startsWith(`${folder}/`);
}

/** Every folder above `path`, outermost first, then `path` itself. */
function ancestry(path: string): string[] {
  const parts = path.split("/").filter(Boolean);
  return parts.map((_, i) => parts.slice(0, i + 1).join("/"));
}

export type Entry =
  | { type: "folder"; id: string; path: string; name: string; count: number }
  | { type: "record"; id: string; record: RecordInfo; name: string };

/** A folder's entry ID (in lists, beside record IDs). */
export const folderId = (path: string) => `folder:${path}`;
export const isFolderId = (id: string) => id.startsWith("folder:");
export const pathOfId = (id: string) => id.slice("folder:".length);
/** An entry's key in its folder's arrangement: a record's ID, or `folder:<name>`. */
export const keyOf = (e: Entry): string => (e.type === "folder" ? `folder:${e.name}` : e.id);

/** What the folders hold. A folder whose records are all archived is hidden; an empty one shows. */
export class Contents {
  readonly folders: string[];
  private records = new Map<string, RecordInfo[]>();
  private subfolders = new Map<string, string[]>();

  /** `all`: the space's records, archived ones too. */
  constructor(folders: string[], all: RecordInfo[], archived: (r: RecordInfo) => boolean) {
    const known = new Set(folders);
    const holding = new Set<string>();
    const showing = new Set<string>();
    for (const r of all) {
      const f = folderOf(r);
      for (const a of ancestry(f)) {
        known.add(a);
        holding.add(a);
        if (!archived(r)) showing.add(a);
      }
      if (archived(r)) continue;
      this.records.set(f, [...(this.records.get(f) ?? []), r]);
    }
    this.folders = [...known].filter((f) => !holding.has(f) || showing.has(f)).sort((a, b) => a.localeCompare(b));
    for (const f of this.folders) this.subfolders.set(parentOf(f), [...(this.subfolders.get(parentOf(f)) ?? []), f]);
  }

  has(path: string): boolean {
    return path === "" || this.folders.includes(path);
  }

  subfoldersOf(path: string): string[] {
    return this.subfolders.get(path) ?? [];
  }

  recordsIn(path: string): RecordInfo[] {
    return this.records.get(path) ?? [];
  }

  /** Records in a folder and every folder inside it. */
  recordsUnder(path: string): RecordInfo[] {
    return [path, ...this.folders.filter((f) => f.startsWith(`${path}/`))].flatMap((f) => this.recordsIn(f));
  }

  /** The folder's entries: its subfolders, then its records (unsorted). */
  entries(path: string): Entry[] {
    return [
      ...this.subfoldersOf(path).map((p): Entry => ({ type: "folder", id: folderId(p), path: p, name: nameOf(p), count: this.subfoldersOf(p).length + this.recordsIn(p).length })),
      ...this.recordsIn(path).map((r): Entry => ({ type: "record", id: r.id, record: r, name: r.title || "Untitled" })),
    ];
  }
}

export type SortKey = "name" | "kind" | "added" | "manual";
export interface Sort {
  key: SortKey;
  dir: 1 | -1;
}

const byName = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/**
 * Folders first, then by the sort key, then by name. "manual" is the order the user arranged
 * (`order`, as keys); what it doesn't list comes after, folders first.
 */
export function sortEntries(entries: Entry[], sort: Sort, kindName: (r: RecordInfo) => string, order: string[] = []): Entry[] {
  if (sort.key === "manual") {
    const at = new Map(order.map((k, i) => [k, i]));
    const rank = (e: Entry) => at.get(keyOf(e)) ?? Infinity;
    return [...entries].sort((a, b) => {
      if (rank(a) !== rank(b)) return rank(a) < rank(b) ? -1 : 1;
      if (a.type !== b.type) return a.type === "record" ? 1 : -1;
      return byName.compare(a.name, b.name);
    });
  }
  const key = (e: Entry): string => (e.type !== "record" ? "" : sort.key === "kind" ? kindName(e.record) : sort.key === "added" ? e.record.created ?? "" : "");
  return [...entries].sort((a, b) => {
    if (a.type !== b.type) return a.type === "record" ? 1 : -1;
    return (byName.compare(key(a), key(b)) || byName.compare(a.name, b.name)) * sort.dir;
  });
}

/** The arrangement after placing `moving` just before or after `anchor` (unchanged if the anchor moves). */
export function placed(current: string[], moving: string[], anchor: string, where: "before" | "after"): string[] {
  if (moving.includes(anchor)) return current;
  const rest = current.filter((k) => !moving.includes(k));
  const i = rest.indexOf(anchor);
  if (i < 0) return [...rest, ...moving];
  const at = where === "before" ? i : i + 1;
  return [...rest.slice(0, at), ...moving, ...rest.slice(at)];
}

/** "untitled folder", then "untitled folder 2", … (as Finder names new folders). */
export function uniqueName(base: string, taken: (name: string) => boolean): string {
  if (!taken(base)) return base;
  for (let i = 2; ; i++) if (!taken(`${base} ${i}`)) return `${base} ${i}`;
}

/** Why a typed folder name can't be used, or null when it can. */
export function badFolderName(name: string): string | null {
  const t = name.trim();
  if (!t) return "A folder needs a name.";
  if (t.includes("/")) return "A folder name can’t contain “/”.";
  if (t.startsWith(".")) return "A folder name can’t start with a dot.";
  if (/[\\:]/.test(t) || /\p{Cc}/u.test(t)) return "A folder name can’t contain “\\” or “:”.";
  return null;
}
