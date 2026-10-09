/**
 * The interface's copy of the records table: loaded when the library opens, kept current by
 * `records.changed` (which names IDs; each is fetched again, or dropped if it has gone). Also how
 * records look in lists (icon, kind name) and which page opens each kind.
 */
import { call, on } from "../backend";
import { count } from "../ui/format";
import { signal } from "../ui/signal";
import type { IconNode } from "../ui/icon";
import type { RecordInfo } from "../types";
import { pages } from "./pages";
import { router } from "./router";
import { showStatus } from "./status";
import { BookOpen, FileText, Globe, Image, Quote, Shapes } from "lucide";

/** Every record, by ID, archived ones too. Replaced (never mutated) on each change. */
export const records = signal<ReadonlyMap<string, RecordInfo>>(new Map());

export async function loadRecords(): Promise<void> {
  const list = await call<RecordInfo[]>("records.list", {}).catch(() => [] as RecordInfo[]);
  records.set(new Map(list.map((r) => [r.id, r])));
}

export function getRecord(id: string | undefined): RecordInfo | undefined {
  return id ? records().get(id) : undefined;
}

/** Records a write's result at once (the window shows its own edits before the event). */
export function putRecord(r: RecordInfo): void {
  records.set(new Map(records.peek()).set(r.id, r));
}

on<{ ids: string[] }>("records.changed", async ({ ids }) => {
  const got = await Promise.all(ids.map((id) => call<RecordInfo>("records.get", { id }).then((r) => [id, r] as const, () => [id, null] as const)));
  const m = new Map(records.peek());
  for (const [id, r] of got) {
    if (r) m.set(id, r);
    else m.delete(id);
  }
  records.set(m);
});

const ARCHIVED = "archive.at";
/** Archived records are left out of lists, the sidebar and search. */
export const isArchived = (r: RecordInfo | undefined): boolean => r?.fields[ARCHIVED] != null;

/** Records of a kind (or all), without archived ones. */
export function listRecords(kind?: string): RecordInfo[] {
  return [...records().values()].filter((r) => (!kind || r.kind === kind) && !isArchived(r));
}

/** A library item's format: pdf, epub, image or web. */
export const formatOf = (r: RecordInfo): string => String(r.fields["library.format"] ?? "");

const KIND_ICONS: Record<string, IconNode> = { note: FileText, capture: Quote, board: Shapes };
const FORMAT_ICONS: Record<string, IconNode> = { pdf: FileText, epub: BookOpen, image: Image, web: Globe };
const KIND_NAMES: Record<string, string> = { note: "Note", capture: "Capture", board: "Board", item: "Item" };
const FORMAT_NAMES: Record<string, string> = { web: "Web page", pdf: "PDF", epub: "EPUB", image: "Image" };

export function recordIcon(r: RecordInfo): IconNode {
  return (r.kind === "item" ? FORMAT_ICONS[formatOf(r)] : KIND_ICONS[r.kind]) ?? FileText;
}

export function kindName(r: RecordInfo): string {
  return (r.kind === "item" ? FORMAT_NAMES[formatOf(r)] : undefined) ?? KIND_NAMES[r.kind] ?? r.kind;
}

/** A short line beside a name in lists: a web page's site and snapshots, a document's pages. */
export function recordDetail(r: RecordInfo): string {
  if (r.kind !== "item") return "";
  if (formatOf(r) === "web") {
    const src = (r.fields.provenance as { source?: string } | undefined)?.source;
    let host = "";
    try {
      host = src ? new URL(src).hostname.replace(/^www\./, "") : "";
    } catch {
      /* not an address */
    }
    const n = Array.isArray(r.fields["library.snapshots"]) ? r.fields["library.snapshots"].length : 0;
    return [host, n > 1 ? count(n, "snapshot") : ""].filter(Boolean).join(" · ");
  }
  const n = Number(r.fields["library.pages"]);
  return n > 0 ? count(n, "page") : "";
}

/** The page that opens each kind of record. */
const PAGE_OF: Record<string, string> = { note: "note", item: "item", capture: "capture", board: "board" };

export function canOpen(r: RecordInfo): boolean {
  return !!pages[PAGE_OF[r.kind] ?? ""];
}

/** Opens a record on its page (with extra params, such as a place in it). */
export function openRecord(id: string, params: Record<string, string> = {}, opts: { newTab?: boolean; again?: boolean } = {}): void {
  const r = records.peek().get(id);
  const page = r && PAGE_OF[r.kind];
  if (page && pages[page]) router.go(page, { id, ...params }, opts);
  else showStatus("That record can’t be opened here.");
}
