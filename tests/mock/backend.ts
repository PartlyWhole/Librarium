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
  /** Pending deletion confirmations: token → [id, version]. */
  confirmations: new Map<string, [string, string][]>(),
  /** Files deleted permanently (paths), for tests. */
  deleted: [] as string[],
  /** Pending snapshot removals: token → [item, snapshots]. */
  snapshotRemovals: new Map<string, [string, string[]][]>(),
  /** Each kind's folders that exist on disk (empty ones too), as "kind:path"; records'
   * folders count as well. */
  folders: new Set<string>(),
  nextOrigin: new Map<string, string>(),
  /** Version history: record → versions (oldest first). */
  history: new Map<string, { hash: string; ms: number; origin: string; body: string; title: string; path: string }[]>(),
  /** Arrangements by hand: kind → folder → keys. */
  order: {} as Record<string, Record<string, string[]>>,
};

const FOLDERED = ["note", "item"];

/** A record's folder inside its kind's top folder ("" at the top). */
function folderOf(info: RecordInfo): string {
  const parts = info.path.split("/").slice(1);
  return parts.slice(0, parts[parts.length - 1] === "record.json" ? -2 : -1).join("/");
}

function pathFor(info: RecordInfo, folder: string, title = info.title): string {
  const top = info.kind === "item" ? "items" : info.kind === "capture" ? "captures" : "notes";
  const sub = folder ? `${folder}/` : "";
  return info.kind === "item" ? `${top}/${sub}${info.id}-${slug(title)}/record.json` : `${top}/${sub}${info.id}-${slug(title)}.md`;
}

/** Two texts compared line by line (a plain longest-common-subsequence diff). */
function lineDiff(a: string, b: string): { op: string; text: string }[] {
  const x = a.replace(/\n$/, "").split("\n");
  const y = b.replace(/\n$/, "").split("\n");
  const L = Array.from({ length: x.length + 1 }, () => new Array<number>(y.length + 1).fill(0));
  for (let i = x.length - 1; i >= 0; i--) for (let j = y.length - 1; j >= 0; j--) L[i]![j] = x[i] === y[j] ? L[i + 1]![j + 1]! + 1 : Math.max(L[i + 1]![j]!, L[i]![j + 1]!);
  const out: { op: string; text: string }[] = [];
  let i = 0;
  let j = 0;
  while (i < x.length || j < y.length) {
    if (i < x.length && j < y.length && x[i] === y[j]) {
      out.push({ op: "equal", text: x[i]! });
      i++;
      j++;
    } else if (j < y.length && (i >= x.length || L[i]![j + 1]! >= L[i + 1]![j]!)) out.push({ op: "insert", text: y[j++]! });
    else out.push({ op: "delete", text: x[i++]! });
  }
  return out;
}

function allFolders(kind: string): string[] {
  const out = new Set([...state.folders].filter((f) => f.startsWith(`${kind}:`)).map((f) => f.slice(kind.length + 1)));
  for (const r of state.records.values()) {
    if (r.info.kind !== kind) continue;
    const parts = folderOf(r.info).split("/").filter(Boolean);
    for (let i = 1; i <= parts.length; i++) out.add(parts.slice(0, i).join("/"));
  }
  return [...out].sort();
}

function folderKind(kind: string): string {
  if (!FOLDERED.includes(kind)) fail("invalid-input", `“${kind}” records aren’t kept in folders`);
  return kind;
}

function cleanFolder(p: string): string {
  const f = String(p ?? "").trim().replace(/^\/+|\/+$/g, "");
  if (!f || f.split("/").some((x) => !x || x.startsWith(".") || x.trim() !== x)) fail("invalid-input", `“${f}” can’t be a folder name`);
  return f;
}

function moveTo(r: Rec, folder: string) {
  if (!FOLDERED.includes(r.info.kind)) fail("invalid-input", `“${r.info.title}” can’t be put in a folder`);
  r.info.path = pathFor(r.info, folder);
  const field = r.info.kind === "item" ? "library.folder" : "notes.folder";
  if (folder) r.info.fields[field] = folder;
  else delete r.info.fields[field];
  return { info: r.info, seq: touch(r, "renamed") };
}

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

function archivedAt(r: Rec): boolean {
  return r.info.fields["archive.at"] != null;
}

function setArchived(p: { id: string; base_version?: string }, at: string | null) {
  const r = need(p.id);
  if (p.base_version && p.base_version !== r.info.version) fail("conflict", "the record changed since it was read");
  if (at === null) delete r.info.fields["archive.at"];
  else r.info.fields["archive.at"] = at;
  return { info: r.info, seq: touch(r, "updated") };
}

function touch(r: Rec, op: "created" | "updated" | "renamed", origin = "app") {
  r.info.version = version(r.body, r.info);
  // History, as the kernel keeps it (without the spacing): one version per distinct text.
  if (r.info.kind === "note" || r.info.kind === "capture") {
    const vs = state.history.get(r.info.id) ?? [];
    if (vs[vs.length - 1]?.hash !== r.info.version) vs.push({ hash: r.info.version, ms: Date.now() + vs.length, origin: state.nextOrigin.get(r.info.id) ?? origin, body: r.body, title: r.info.title, path: r.info.path });
    state.nextOrigin.delete(r.info.id);
    state.history.set(r.info.id, vs);
  }
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
  if (kind === "item") info.path = pathFor(info, folder);
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
  "library.importData": (p) => {
    const info = seed("item", String(p.name).replace(/\.[^.]+$/, ""), "", { "library.format": "image", "library.original": "original.png", sha256: "…", ...(p.folder ? { "library.folder": p.folder } : {}) }, p.folder ?? "");
    const bin = atob(String(p.data));
    files.set(info.id, Uint8Array.from(bin, (c) => c.charCodeAt(0)).buffer);
    return { info, seq: touch(need(info.id), "created") };
  },
  "records.text": (p) => {
    const r = need(p.id);
    const text = mockTexts.get(p.id) ?? r.body;
    return { text, segments: mockSegments.get(p.id) ?? [{ label: "", start: 0, end: [...text].length }], origin: null };
  },
  "captures.create": (p) => {
    const quote = p.parts.map((x: { quote: string }) => x.quote).filter(Boolean).join(" […] ");
    const info = seed("capture", quote.split(/\s+/).slice(0, 8).join(" ") || "A region", p.words ?? "", { "captures.source": p.source, "captures.quote": quote, "captures.parts": p.parts.length, ...(p.parts[0]?.locator ? { "captures.locator": p.parts[0].locator } : {}) });
    anchors.set(info.id, { id: info.id, source: p.source, snapshot: null, text: p.text, parts: partsOf(info.id, p.parts) });
    return { info, seq: touch(need(info.id), "created") };
  },
  "captures.update": (p) => {
    const r = need(p.id);
    if (!p.parts.length) fail("invalid-input", "a capture needs at least one part");
    const quote = p.parts.map((x: { quote: string }) => x.quote).filter(Boolean).join(" […] ");
    const auto = (q: string) => q.split(/\s+/).slice(0, 8).join(" ") || "A region";
    if (r.info.title === auto(String(r.info.fields["captures.quote"] ?? ""))) r.info.title = auto(quote);
    r.info.fields = { ...r.info.fields, "captures.quote": quote, "captures.parts": p.parts.length };
    const a = anchors.get(p.id);
    if (a) a.parts = partsOf(p.id, p.parts);
    return { info: r.info, seq: touch(r, "updated") };
  },
  "captures.anchor": (p) => anchors.get(p.id) ?? fail("not-found", "no anchor"),
  "captures.forSource": (p) =>
    [...state.records.values()]
      .filter((r) => r.info.kind === "capture" && r.info.fields["captures.source"] === p.source && (anchors.get(r.info.id)?.snapshot ?? null) === (p.snapshot ?? null))
      .map((r) => ({
        id: r.info.id,
        title: r.info.title,
        parts: (anchors.get(r.info.id)?.parts ?? []).map((part: { selector: { value?: string; refinedBy?: { value?: string } }[]; boxes?: unknown[] }) => {
          const frag = (prefix: string) => part.selector.flatMap((s) => [s.value, s.refinedBy?.value]).find((v) => v?.startsWith(prefix));
          return { boxes: part.boxes ?? [], cfi: frag("epubcfi(") ?? null, region: !!frag("xywh=") };
        }),
      })),
  "captures.updateAnchor": (p) => {
    const a = anchors.get(p.id);
    if (a) a.parts = p.parts;
    return { seq: state.seq };
  },
  "captures.orphans": () => [],
  "captures.region": (p) => regions.get(`${p.id}#${p.n}`) ?? "data:image/png;base64,",
  "export.write": (p) => (exports.set(p.path, p.text), null),
  "jobs.dismiss": (p) => ((state.jobs = state.jobs.filter((j) => j.id !== p.id)), null),
  "jobs.retry": (p) => {
    const j = state.jobs.find((x) => x.id === p.id);
    if (j) j.state = "queued";
    return j ?? null;
  },
  "jobs.list": () => ({ running: state.jobs.filter((j) => j.state === "running" || j.state === "queued"), failed: state.jobs.filter((j) => j.state === "failed"), recent: state.jobs.filter((j) => j.state === "done"), resumed: null }),
  "index.rebuild": () => ({ id: "0192f3a4-7c1e-7b2a-9f00-0000000000ff", kind: "index.rebuild", key: "all", state: "queued", title: "Rebuilding the index", attempts: 0, error: null, progress: null, message: null, payload: null, created_ms: 0, updated_ms: 0 }),
  "library.removeSnapshots.prepare": (p: { items: { id: string; snapshots?: string[] }[] }) => {
    const items = p.items.map((it) => {
      const r = need(it.id);
      const all = ((r.info.fields["library.snapshots"] as { at: string }[] | undefined) ?? []).map((s) => s.at);
      let remove = it.snapshots ? all.filter((a) => it.snapshots!.includes(a)) : all.slice(0, -1);
      if (remove.length === all.length) remove = remove.slice(0, -1);
      return { id: it.id, title: r.info.title, remove, protected: [], kept: all.length - remove.length };
    });
    const token = `token-${state.idn++}`;
    state.snapshotRemovals.set(token, items.map((i) => [i.id, i.remove]));
    return { token, count: items.reduce((n, i) => n + i.remove.length, 0), items };
  },
  "library.removeSnapshots": (p: { token?: string }) => {
    const c = p.token ? state.snapshotRemovals.get(p.token) : undefined;
    if (!c) fail("invalid-input", "That confirmation has expired. Nothing was removed.");
    state.snapshotRemovals.delete(p.token!);
    let removed = 0;
    for (const [id, gone] of c) {
      const r = need(id);
      const keep = (r.info.fields["library.snapshots"] as { at: string }[]).filter((s) => !gone.includes(s.at));
      r.info.fields["library.snapshots"] = keep;
      r.info.fields["library.snapshot"] = keep[keep.length - 1]?.at;
      removed += gone.length;
      touch(r, "updated");
    }
    return { removed, skipped: [] };
  },
  "archive.archive": (p) => setArchived(p, "2026-10-02T10:00:00Z"),
  "archive.restore": (p) => setArchived(p, null),
  "archive.list": () => [...state.records.values()].filter(archivedAt).map((r) => r.info),
  "archive.prepareDelete": (p: { ids: string[] }) => {
    if (!p.ids?.length) fail("invalid-input", "nothing to delete");
    const records = p.ids.map((id) => {
      const r = need(id);
      if (!archivedAt(r)) fail("invalid-input", "Archive it first: only archived records can be deleted permanently.");
      return { id, title: r.info.title, kind: r.info.kind, version: r.info.version, files: [r.info.path] };
    });
    const token = `token-${state.idn++}`;
    state.confirmations.set(token, records.map((r) => [r.id, r.version]));
    return { token, records, files: records.length, expires_ms: Date.now() + 300_000 };
  },
  "archive.delete": (p: { token?: string }) => {
    const c = p.token ? state.confirmations.get(p.token) : undefined;
    if (!c) fail("invalid-input", "That confirmation has expired. Nothing was deleted.");
    state.confirmations.delete(p.token!);
    const out = { deleted: [] as string[], skipped: [] as { id: string; reason: string }[] };
    for (const [id, v] of c) {
      const r = state.records.get(id);
      if (!r || !archivedAt(r) || r.info.version !== v) {
        out.skipped.push({ id, reason: "it changed since you confirmed; nothing was deleted" });
        continue;
      }
      state.records.delete(id);
      state.deleted.push(r.info.path);
      const seq = ++state.seq;
      queueMicrotask(() => emit("event.change", { seq, id, kind: r.info.kind, op: "removed", origin: "app" }));
      out.deleted.push(id);
    }
    return out;
  },
  "search.query": (p) => {
    const words = String(p.text).toLowerCase().split(/\s+/).filter((w) => w && !w.startsWith("-"));
    return [...state.records.values()]
      .filter((r) => !(p.hide ?? []).some((f: string) => r.info.fields[f] != null))
      .filter((r) => (!p.kinds?.length || p.kinds.includes(r.info.kind)) && words.every((w) => (r.info.title + " " + r.body).toLowerCase().includes(w.replace(/"/g, ""))))
      .map((r) => ({ id: r.info.id, kind: r.info.kind, title: r.info.title, snippet: r.body.replace(new RegExp(`(${words.map((w) => w.replace(/[^\p{L}\p{N}]/gu, "")).join("|")})`, "giu"), "\u0002$1\u0003"), offset: 0, score: 1 }));
  },
  "links.backlinks": (p) => [...state.records.values()].filter((r) => r.body.includes(`|${p.id}]]`)).map((r) => ({ source: r.info.id, title: r.info.title, kind: r.info.kind, context: r.body.split("\n").find((l) => l.includes(p.id)) ?? "", embed: false })),
  "links.unresolved": () => [],
  "folder.inspect": (p) => ({ path: p.path, ...state.inspect }),
  "folder.reveal": () => null,
  "app.openUrl": (p) => {
    if (!/^(https?:\/\/|mailto:)/i.test(p.url ?? "")) fail("invalid-input", "Only web and mail addresses are opened.");
    return null;
  },
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
    if (p.title) r.info.title = p.title;
    r.info.path = pathFor(r.info, p.subfolder !== undefined ? p.subfolder ?? "" : folderOf(r.info));
    return { info: r.info, seq: touch(r, "renamed") };
  },
  "records.move": (p) => {
    const moved = [];
    const failed = [];
    for (const id of p.ids as string[]) {
      try {
        moved.push(moveTo(need(id), p.folder ? cleanFolder(p.folder) : ""));
      } catch (e) {
        failed.push({ id, error: (e as Error).message });
      }
    }
    return { moved, failed };
  },
  "history.versions": (p) => [...(state.history.get(p.id) ?? [])].reverse().map((v) => ({ hash: v.hash, ms: v.ms, origin: v.origin, size: v.body.length, title: v.title, path: v.path, current: v.hash === state.records.get(p.id)?.info.version })),
  "history.read": (p) => {
    const v = (state.history.get(p.id) ?? []).find((x) => x.hash === p.hash);
    if (!v) fail("not-found", "That version isn’t in this note’s history.");
    return v.body;
  },
  "history.diff": (p) => {
    const v = (state.history.get(p.id) ?? []).find((x) => x.hash === p.hash);
    if (!v) fail("not-found", "That version isn’t in this note’s history.");
    return lineDiff(v.body, need(p.id).body);
  },
  "history.restore": (p) => {
    const r = need(p.id);
    if (p.base_version !== r.info.version) fail("conflict", "The note changed since; look again before restoring.");
    const v = (state.history.get(p.id) ?? []).find((x) => x.hash === p.hash);
    if (!v) fail("not-found", "That version isn’t in this note’s history.");
    state.nextOrigin.set(p.id, "restore");
    r.body = v.body;
    const seq = touch(r, "updated");
    return { outcome: "saved", version: r.info.version, seq };
  },
  "history.deleted": () => [...state.history].filter(([id]) => !state.records.has(id)).map(([id, vs]) => ({ id, kind: "note", title: vs[vs.length - 1]!.title, path: vs[vs.length - 1]!.path, ms: vs[vs.length - 1]!.ms })),
  "history.bringBack": (p) => {
    const vs = state.history.get(p.id) ?? [];
    const v = vs[vs.length - 1];
    if (!v || state.records.has(p.id)) fail("conflict", "It is already in the library.");
    const info: RecordInfo = { id: p.id, kind: "note", title: v.title, path: v.path, version: "", created: null, read_only: null, fields: {}, conflicts: [] };
    const r = { info, body: v.body };
    state.records.set(p.id, r);
    return { info, seq: touch(r, "created") };
  },
  "folders.list": () => ({ spaces: FOLDERED.map((kind) => ({ kind, kinds: [kind], folders: allFolders(kind), order: structuredClone(state.order[kind] ?? {}) })) }),
  "folders.setOrder": (p) => {
    const o = (state.order[folderKind(p.kind)] ??= {});
    if (p.order.length) o[p.path] = [...new Set<string>(p.order)];
    else delete o[p.path];
    return null;
  },
  "folders.create": (p) => {
    const kind = folderKind(p.kind);
    const f = cleanFolder(p.path);
    if (allFolders(kind).includes(f)) fail("conflict", `There’s already a folder called “${f.split("/").pop()}” there.`);
    state.folders.add(`${kind}:${f}`);
    return { path: f, moved: 0 };
  },
  "folders.move": (p) => {
    const kind = folderKind(p.kind);
    const from = cleanFolder(p.from);
    const to = cleanFolder(p.to);
    if (to.startsWith(`${from}/`)) fail("invalid-input", `“${from.split("/").pop()}” can’t go inside itself.`);
    const all = allFolders(kind);
    if (!all.includes(from)) fail("not-found", `There’s no folder “${from}” any more.`);
    if (all.includes(to)) fail("conflict", `There’s already a folder called “${to.split("/").pop()}” there.`);
    const under = (f: string) => f === from || f.startsWith(`${from}/`);
    const swap = (f: string) => to + f.slice(from.length);
    for (const k of [...state.folders]) {
      const f = k.slice(kind.length + 1);
      if (!k.startsWith(`${kind}:`) || !under(f)) continue;
      state.folders.delete(k);
      state.folders.add(`${kind}:${swap(f)}`);
    }
    let moved = 0;
    for (const r of state.records.values()) {
      if (r.info.kind !== kind || !under(folderOf(r.info))) continue;
      moveTo(r, swap(folderOf(r.info)));
      moved++;
    }
    return { path: to, moved };
  },
  "folders.remove": (p) => {
    const kind = folderKind(p.kind);
    const f = cleanFolder(p.path);
    const inside = [...state.records.values()].filter((r) => r.info.kind === kind && (folderOf(r.info) === f || folderOf(r.info).startsWith(`${f}/`)));
    if (inside.length) fail("conflict", `“${f.split("/").pop()}” isn’t empty: it holds ${inside.length} ${inside.length === 1 ? "item" : "items"} (archived ones count too).`);
    for (const x of [...state.folders]) if (x === `${kind}:${f}` || x.startsWith(`${kind}:${f}/`)) state.folders.delete(x);
    return null;
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
/** Region images of captures, by `id#n` (1-based), as data URLs. */
export const regions = new Map<string, string>();
function partsOf(id: string, parts: { selector: unknown; boxes?: unknown[]; region_png?: string | null }[]) {
  return parts.map((x, i) => {
    if (x.region_png) regions.set(`${id}#${i + 1}`, x.region_png.startsWith("data:") ? x.region_png : `data:image/png;base64,${x.region_png}`);
    return { selector: x.selector, ...(x.boxes?.length ? { boxes: x.boxes } : {}), ...(x.region_png ? { region: `.region-${i + 1}.png` } : {}) };
  });
}
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

export async function closeWindow(): Promise<void> {}

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
    state.confirmations.clear();
    state.snapshotRemovals.clear();
    state.folders.clear();
    state.order = {};
    state.history.clear();
    state.nextOrigin.clear();
    state.deleted = [];
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
