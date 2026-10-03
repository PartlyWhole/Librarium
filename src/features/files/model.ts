/**
 * The user's folders as the interface sees them: one tree across the kinds kept in folders
 * (a folder path is the same in `notes/` and `items/`), with what each folder holds.
 */
import type { RecordInfo } from "../../generated/RecordInfo";

/** A record's folder inside its kind's top folder ("" at the top level). */
export function folderOf(r: RecordInfo): string {
  const parts = r.path.split("/").slice(1);
  return parts.slice(0, parts[parts.length - 1] === "record.json" ? -2 : -1).join("/");
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
export function ancestry(path: string): string[] {
  const parts = path.split("/").filter(Boolean);
  return parts.map((_, i) => parts.slice(0, i + 1).join("/"));
}

export type Entry =
  | { type: "folder"; id: string; path: string; name: string; count: number }
  | { type: "record"; id: string; record: RecordInfo; name: string };

export const folderId = (path: string) => `folder:${path}`;
export const isFolderId = (id: string) => id.startsWith("folder:");
export const pathOfId = (id: string) => id.slice("folder:".length);

/**
 * What the folders hold. A folder whose records are all hidden (archived) is hidden too; an
 * empty folder is shown.
 */
export class Contents {
  readonly folders: string[];
  private records = new Map<string, RecordInfo[]>();
  private subfolders = new Map<string, string[]>();
  private holding = new Set<string>();
  private showing = new Set<string>();

  constructor(folders: string[], all: RecordInfo[], kinds: string[], hidden: (r: RecordInfo) => boolean) {
    const known = new Set(folders);
    for (const r of all) {
      if (!kinds.includes(r.kind)) continue;
      const f = folderOf(r);
      for (const a of ancestry(f)) {
        known.add(a);
        this.holding.add(a);
        if (!hidden(r)) this.showing.add(a);
      }
      if (hidden(r)) continue;
      const list = this.records.get(f);
      if (list) list.push(r);
      else this.records.set(f, [r]);
    }
    this.folders = [...known].filter((f) => this.shown(f)).sort((a, b) => a.localeCompare(b));
    for (const f of this.folders) {
      const p = parentOf(f);
      const list = this.subfolders.get(p);
      if (list) list.push(f);
      else this.subfolders.set(p, [f]);
    }
  }

  /** Shown unless everything in it is hidden. */
  private shown(f: string): boolean {
    return !this.holding.has(f) || this.showing.has(f);
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

  /** Visible records in a folder and all the folders inside it. */
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

export type SortKey = "name" | "kind" | "added";
export interface Sort {
  key: SortKey;
  dir: 1 | -1;
}

const byName = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** Folders first (as in Drive), then by the sort key, then by name. */
export function sortEntries(entries: Entry[], sort: Sort, kindName: (r: RecordInfo) => string): Entry[] {
  const key = (e: Entry): string => {
    if (sort.key === "kind") return e.type === "folder" ? "" : kindName(e.record);
    if (sort.key === "added") return e.type === "folder" ? "" : e.record.created ?? "";
    return "";
  };
  return [...entries].sort((a, b) => {
    if (a.type !== b.type) return a.type === "folder" ? -1 : 1;
    const k = sort.key === "name" ? 0 : byName.compare(key(a), key(b));
    return (k || byName.compare(a.name, b.name)) * sort.dir;
  });
}

/** "untitled folder", then "untitled folder 2", … (as Finder names new folders). */
export function uniqueName(base: string, taken: (name: string) => boolean): string {
  if (!taken(base)) return base;
  for (let i = 2; ; i++) if (!taken(`${base} ${i}`)) return `${base} ${i}`;
}

/** Checks a folder name typed by the user; returns why it can't be used, if it can't. */
export function badFolderName(name: string): string | null {
  const t = name.trim();
  if (!t) return "A folder needs a name.";
  if (t.includes("/")) return "A folder name can’t contain “/”.";
  if (t.startsWith(".")) return "A folder name can’t start with a dot.";
  if (/[\\:]/.test(t) || /\p{Cc}/u.test(t)) return "A folder name can’t contain “\\” or “:”.";
  return null;
}
