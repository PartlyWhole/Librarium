/**
 * What a record's context menu offers, wherever it is listed (the sidebar, a folder page, the
 * Archive). Features add entries with `addRecordAction`; Open and Open in new tab come first,
 * destructive entries last.
 */
import { contextMenu, type MenuItem, type Point } from "../ui/menu";
import type { RecordInfo } from "../types";
import { canOpen, openRecord } from "./records";

interface RecordAction {
  id: string;
  /** The label, given how many records it acts on. */
  label: string | ((n: number) => string);
  /** Whether it is offered for this record (with several, for every one of them). */
  applies(r: RecordInfo): boolean;
  run(rs: RecordInfo[]): void | Promise<void>;
  destructive?: boolean;
  /** With several selected: offered when it applies to some, and run on those. */
  partial?: boolean;
  /** Only for one record at a time (renaming). */
  single?: boolean;
}

/** The entries' order in menus; entries not listed come before the archive's. */
const ORDER = ["rename", "move", "move-to-library", "remove-snapshots", "archive", "restore", "delete"];
const rank = (a: RecordAction) => (a.destructive ? 100 : 0) + (ORDER.includes(a.id) ? ORDER.indexOf(a.id) : 3.5);
const all: RecordAction[] = [];

export function addRecordAction(a: RecordAction): void {
  all.push(a);
  all.sort((x, y) => rank(x) - rank(y));
}

/** What can be done with these records (the menu's entries, without Open). */
export function recordActionsFor(rs: RecordInfo[]): Exclude<MenuItem, "separator">[] {
  return all
    .filter((a) => !a.single || rs.length === 1)
    .map((a) => ({ a, on: a.partial ? rs.filter((r) => a.applies(r)) : rs.length && rs.every((r) => a.applies(r)) ? rs : [] }))
    .filter((x) => x.on.length)
    .map(({ a, on }) => ({ label: typeof a.label === "function" ? a.label(on.length) : a.label, destructive: a.destructive, run: () => void a.run(on) }));
}

/** Opens the context menu of a record, or of several selected, at a point. */
export function showRecordMenu(rs: RecordInfo[], at: Point): void {
  const one = rs.length === 1 ? rs[0]! : null;
  const items: MenuItem[] = one && canOpen(one) ? [{ label: "Open", run: () => openRecord(one.id) }, { label: "Open in new tab", run: () => openRecord(one.id, {}, { newTab: true }) }] : [];
  const more = recordActionsFor(rs);
  if (items.length && more.length) items.push("separator");
  items.push(...more);
  if (items.length) contextMenu(items, at, one ? one.title || "Untitled" : `${rs.length} items`);
}
