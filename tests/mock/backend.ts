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
    const r = need(p.id);
    if (r.info.version !== p.base_version) return { outcome: "conflict", version: r.info.version, body: r.body };
    r.body = p.body;
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
    if (p.title) r.info.title = p.title;
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
    state.idn = 1;
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
    seed("item", "The Technological Society");
  },
};

if (typeof window !== "undefined" && (import.meta as unknown as { env?: { MODE?: string } }).env?.MODE === "mock") mock.sample();
