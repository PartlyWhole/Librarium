/**
 * An in-process stand-in for src/backend.ts (the Transport's test adapter on the interface
 * side). Vitest and the browser preview (`npm run dev:mock`) alias `backend` to this file.
 * It keeps records in memory and answers the same API calls.
 */
import type { BackendError } from "../../src/generated/BackendError";
import type { LibraryStatus } from "../../src/generated/LibraryStatus";
import type { RecordInfo } from "../../src/generated/RecordInfo";
import type { MenuSection } from "../../src/backend";

export type { BackendError };
export type { MenuEntry, MenuSection, PredefinedItem } from "../../src/backend";

export class BackendCallError extends Error implements BackendError {
  code: BackendError["code"];
  data: unknown;
  constructor(e: BackendError) {
    super(e.message);
    this.code = e.code;
    this.data = e.data;
  }
}

interface Rec {
  info: RecordInfo;
  body: string;
}

const state = {
  folder: null as string | null,
  records: new Map<string, Rec>(),
  settings: {} as Record<string, unknown>,
  seq: 0,
  calls: [] as { method: string; params: unknown }[],
  menu: [] as MenuSection[],
  pick: null as string | null,
  drafts: new Map<string, { id: string; base_version: string; base_body: string; body: string; updated_ms: number }>(),
  /** Make records.save fail with this error (e.g. a read-only file). */
  failSave: null as string | null,
  today: "2026-10-02",
  savePath: null as string | null,
  jobs: [] as { state: string; [k: string]: unknown }[],
  inspect: { exists: true, empty: true, is_library: false, markdown_files: 0, in_icloud: false },
  idn: 1,
};

const listeners = new Map<string, Set<(p: unknown) => void>>();

function emit(method: string, params: unknown) {
  for (const fn of listeners.get(method) ?? []) fn(params);
}

function status(): LibraryStatus {
  if (!state.folder) return { state: "none", path: null, id: null, in_icloud: false, store: null, error: null };
  return { state: "open", path: state.folder, id: "0192f3a4-7c1e-7b2a-9f00-00000000000f", in_icloud: false, store: { phase: "ready", records: state.records.size, last_check: "full", last_check_ms: 1, duplicates: [], pending_repairs: 0 }, error: null };
}

function version(body: string, info: RecordInfo) {
  let h = 0;
  for (const c of body + info.title + JSON.stringify(info.fields)) h = (h * 31 + c.charCodeAt(0)) | 0;
  return `v${(h >>> 0).toString(16)}`;
}

function slug(t: string) {
  return t.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "").replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "");
}

function fail(code: BackendError["code"], message: string): never {
  throw new BackendCallError({ code, message, data: null });
}

function need(id: unknown): Rec {
  const r = state.records.get(String(id));
  if (!r) fail("not-found", `no record ${id}`);
  return r;
}

function touch(r: Rec, op: "created" | "updated" | "renamed") {
  r.info.version = version(r.body, r.info);
  state.seq++;
  const seq = state.seq;
  queueMicrotask(() => emit("event.change", { seq, id: r.info.id, kind: r.info.kind, op, origin: "app" }));
  return seq;
}

/** Adds a record directly (test setup). */
export function seed(kind: string, title: string, body = "", fields: Record<string, unknown> = {}, folder = ""): RecordInfo {
  const id = `0192f3a4-7c1e-7b2a-9f00-${String(state.idn++).padStart(12, "0")}`;
  const top = kind === "item" ? "items" : kind === "capture" ? "captures" : "notes";
  const info: RecordInfo = { id, kind, title, path: `${top}/${folder ? folder + "/" : ""}${id}-${slug(title)}.md`, version: "", created: "2026-10-02T09:14:00Z", read_only: null, fields, conflicts: [] };
  const r = { info, body };
  info.version = version(body, info);
  state.records.set(id, r);
  return info;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- params are whatever each call takes
const api: Record<string, (p: any) => unknown> = {
  "app.info": () => ({ name: "Librarium", version: "mock", api_methods: Object.keys(api) }),
  "worker.ping": () => ({ worker_version: "mock", pid: 0, round_trip_us: 1 }),
  "folder.status": () => status(),
  "folder.open": (p) => {
    state.folder = p.path;
    const st = status();
    queueMicrotask(() => emit("event.status", st));
    return st;
  },
  "folder.close": () => ((state.folder = null), status()),
  "drafts.put": (p) => (state.drafts.set(p.id, { ...p, updated_ms: Date.now() }), null),
  "drafts.get": (p) => state.drafts.get(p.id) ?? null,
  "drafts.list": () => [...state.drafts.values()].filter((d) => state.records.get(d.id)?.body !== d.body),
  "drafts.discard": (p) => (state.drafts.delete(p.id), null),
  "notes.create": (p) => {
    const info = seed("note", p.title || "Untitled", p.body ?? "", {}, p.folder ?? "");
    return { info, seq: touch(need(info.id), "created") };
  },
  "notes.folders": () => [...new Set([...state.records.values()].filter((r) => r.info.kind === "note").map((r) => r.info.path.split("/").slice(1, -1).join("/")).filter(Boolean))].sort(),
  "daily.today": () => {
    const found = [...state.records.values()].find((r) => r.info.fields["daily.date"] === state.today);
    if (found) return { info: found.info, seq: state.seq };
    const info = seed("note", state.today, "", { "daily.date": state.today });
    return { info, seq: touch(need(info.id), "created") };
  },
  "library.text": () => null,
  "library.import": () => ({ imported: [], failed: [] }),
  "records.text": (p) => {
    const r = need(p.id);
    const text = mockTexts.get(p.id) ?? r.body;
    return { text, segments: mockSegments.get(p.id) ?? [{ label: "", start: 0, end: [...text].length }], origin: null };
  },
  "captures.create": (p) => {
    const quote = p.parts.map((x: { quote: string }) => x.quote).filter(Boolean).join(" … ");
    const info = seed("capture", quote.split(/\s+/).slice(0, 8).join(" ") || "A region", p.words ?? "", { "captures.source": p.source, "captures.quote": quote, "captures.parts": p.parts.length, ...(p.parts[0]?.locator ? { "captures.locator": p.parts[0].locator } : {}) });
    anchors.set(info.id, { id: info.id, source: p.source, snapshot: null, text: p.text, parts: p.parts.map((x: { selector: unknown }) => ({ selector: x.selector })) });
    return { info, seq: touch(need(info.id), "created") };
  },
  "captures.anchor": (p) => anchors.get(p.id) ?? fail("not-found", "no anchor"),
  "captures.updateAnchor": (p) => {
    const a = anchors.get(p.id);
    if (a) a.parts = p.parts;
    return { seq: state.seq };
  },
  "captures.orphans": () => [],
  "captures.region": () => "data:image/png;base64,",
  "export.write": (p) => (exports.set(p.path, p.text), null),
  "jobs.list": () => ({ running: state.jobs.filter((j) => j.state === "running" || j.state === "queued"), failed: state.jobs.filter((j) => j.state === "failed"), recent: state.jobs.filter((j) => j.state === "done"), resumed: null }),
  "index.rebuild": () => ({ id: "0192f3a4-7c1e-7b2a-9f00-0000000000ff", kind: "index.rebuild", key: "all", state: "queued", title: "Rebuilding the index", attempts: 0, error: null, progress: null, message: null, payload: null, created_ms: 0, updated_ms: 0 }),
  "search.query": (p) => {
    const words = String(p.text).toLowerCase().split(/\s+/).filter((w) => w && !w.startsWith("-"));
    return [...state.records.values()]
      .filter((r) => (!p.kinds?.length || p.kinds.includes(r.info.kind)) && words.every((w) => (r.info.title + " " + r.body).toLowerCase().includes(w.replace(/"/g, ""))))
      .map((r) => ({ id: r.info.id, kind: r.info.kind, title: r.info.title, snippet: r.body.replace(new RegExp(`(${words.map((w) => w.replace(/[^\p{L}\p{N}]/gu, "")).join("|")})`, "giu"), "\u0002$1\u0003"), offset: 0, score: 1 }));
  },
  "links.backlinks": (p) => [...state.records.values()].filter((r) => r.body.includes(`|${p.id}]]`)).map((r) => ({ source: r.info.id, title: r.info.title, kind: r.info.kind, context: r.body.split("\n").find((l) => l.includes(p.id)) ?? "", embed: false })),
  "links.unresolved": () => [],
  "folder.inspect": (p) => ({ path: p.path, ...state.inspect }),
  "folder.reveal": () => null,
  "app.revealLogs": () => null,
  "settings.get": () => ({ ...state.settings }),
  "settings.set": (p) => (Object.assign(state.settings, p.values), { ...state.settings }),
  "records.list": (p) => [...state.records.values()].map((r) => r.info).filter((i) => !p?.kind || i.kind === p.kind),
  "records.get": (p) => need(p.id).info,
  "records.read": (p) => {
    const r = need(p.id);
    return { info: r.info, frontmatter: `id: "${r.info.id}"\n`, body: r.body };
  },
  "records.create": (p) => {
    const info = seed(p.kind, p.title, p.body ?? "", p.fields ?? {}, p.subfolder ?? "");
    const seq = touch(need(info.id), "created");
    return { info, seq };
  },
  "records.save": (p) => {
    if (state.failSave) fail("io", state.failSave);
    const r = need(p.id);
    if (r.info.version !== p.base_version) return { outcome: "conflict", version: r.info.version, body: r.body };
    r.body = p.body;
    if (state.drafts.get(p.id)?.body === p.body) state.drafts.delete(p.id);
    const seq = touch(r, "updated");
    return { outcome: "saved", version: r.info.version, seq };
  },
  "records.setFields": (p) => {
    const r = need(p.id);
    for (const [k, v] of Object.entries(p.fields as Record<string, unknown>)) {
      if (v === null) delete r.info.fields[k];
      else r.info.fields[k] = v;
    }
    return { info: r.info, seq: touch(r, "updated") };
  },
  "records.relocate": (p) => {
    const r = need(p.id);
    if (p.base_version && p.base_version !== r.info.version) fail("conflict", "It changed since, so this can’t be undone.");
    if (p.subfolder !== undefined) r.info.path = `notes/${p.subfolder ? p.subfolder + "/" : ""}${r.info.id}-${slug(r.info.title)}.md`;
    if (p.title) {
      r.info.title = p.title;
      r.info.path = r.info.path.replace(/[^/]*$/, `${r.info.id}-${slug(p.title)}.md`);
    }
    return { info: r.info, seq: touch(r, "renamed") };
  },
};

export async function call<T>(method: string, params: unknown = null): Promise<T> {
  state.calls.push({ method, params });
  const fn = api[method];
  if (!fn) fail("not-found", `no API call ${method}`);
  return structuredClone(fn(params ?? {})) as T;
}

export function on(method: string, fn: (p: unknown) => void): () => void {
  let s = listeners.get(method);
  if (!s) listeners.set(method, (s = new Set()));
  s.add(fn);
  return () => s!.delete(fn);
}

export function inTauri(): boolean {
  return false;
}

export async function setAppMenu(sections: MenuSection[]): Promise<void> {
  state.menu = sections;
}

export const closeHandlers: (() => Promise<void>)[] = [];

export function onCloseRequested(handler: () => Promise<void>): void {
  closeHandlers.push(handler);
}

/** Bytes of seeded files (tests put them here). */
export const files = new Map<string, ArrayBuffer>();

/** Stored texts and segments for sources (tests set them), anchors and exports. */
export const mockTexts = new Map<string, string>();
export const mockSegments = new Map<string, { label: string; start: number; end: number }[]>();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const anchors = new Map<string, any>();
export const exports = new Map<string, string>();

/** Fixture URLs for items in the browser preview. */
const fileUrls = new Map<string, string>();

export async function readBytes(id: string): Promise<ArrayBuffer> {
  const b = files.get(id);
  if (b) return b;
  const url = fileUrls.get(id);
  if (url) return (await fetch(url)).arrayBuffer();
  fail("not-found", "no file");
}

function seedItem(title: string, format: string, fixture: string, pages?: number) {
  const info = seed("item", title, "", { "library.format": format, "library.original": fixture, ...(pages ? { "library.pages": pages } : {}), provenance: { "original-name": fixture, "saved-at": "2026-10-02T09:14:00Z" }, sha256: "…" });
  fileUrls.set(info.id, `/tests/fixtures/library/${fixture}`);
  return info;
}

export async function pickFiles(): Promise<string[]> {
  return [];
}

export function onFileDrop(): () => void {
  return () => {};
}

export async function pickSavePath(): Promise<string | null> {
  return state.savePath;
}

export async function pickFolder(): Promise<string | null> {
  return state.pick;
}

/** Test controls. */
export const mock = {
  state,
  emit,
  reset() {
    state.folder = null;
    state.records.clear();
    state.settings = {};
    state.seq = 0;
    state.calls = [];
    state.menu = [];
    state.pick = null;
    // IDs keep counting across resets, so nothing from an earlier test can touch a new record.
    listeners.clear();
    state.drafts.clear();
    state.failSave = null;
    state.jobs = [];
    state.inspect = { exists: true, empty: true, is_library: false, markdown_files: 0, in_icloud: false };
  },
  /** A sample library for the browser preview. */
  sample() {
    state.folder = "/Users/me/Library Notes";
    seed("note", "Jacques Ellul", "Notes on *The Technological Society*.\n", {}, "Thinkers");
    seed("note", "Simone Weil", "Attention is the rarest and purest form of generosity.\n", {}, "Thinkers");
    seed("note", "Reading list", "- Ellul\n- Weil\n");
    seed("note", "2026-10-02", "Morning pages.\n", { "daily.date": "2026-10-02" });
    seed("note", "2026-10-01", "Yesterday.\n", { "daily.date": "2026-10-01" });
    seedItem("The Technological Society", "pdf", "short.pdf", 2);
    seedItem("A hundred pages", "pdf", "text-100.pdf", 100);
    seedItem("A JBIG2 scan", "pdf", "jbig2_symbol_offset.pdf", 1);
    seedItem("A JPEG 2000 scan", "pdf", "bug_jpx.pdf", 1);
    seedItem("A JPEG 2000 gradient", "pdf", "gradient-jpx.pdf", 1);
    seedItem("Notebooks", "epub", "notebooks.epub", 2);
    seedItem("A gradient", "image", "gradient.png");
  },
};

if (typeof window !== "undefined" && (import.meta as unknown as { env?: { MODE?: string } }).env?.MODE === "mock") mock.sample();
