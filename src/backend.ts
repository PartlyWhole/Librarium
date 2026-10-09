/**
 * The only file that talks to Tauri. Every backend method goes through one command,
 * `call(method, params)`; events arrive by name. Thin wrappers cover the native dialogs, the
 * window, the menu bar, updates and file addresses.
 */
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Menu, MenuItem, PredefinedMenuItem, Submenu } from "@tauri-apps/api/menu";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getVersion } from "@tauri-apps/api/app";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

export type ErrorCode = "no_library" | "not_found" | "conflict" | "read_only" | "invalid" | "io" | "cancelled" | "internal";

/** An error from the backend, with its code. */
export class BackendError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "BackendError";
  }
}

/** True inside the app's webview; false in a plain browser (`npm run dev:web`). */
const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/**
 * Development only: a plain browser opened at `?bridge=<port>` reaches the real backend over
 * localhost (see `src-tauri/src/devbridge.rs`), so the interface can be tried outside the app.
 */
const bridgePort = !inTauri && import.meta.env.DEV ? new URLSearchParams(location.search).get("bridge") : null;
const bridge = bridgePort ? `http://127.0.0.1:${bridgePort}` : null;

async function viaBridge<T>(method: string, params: unknown): Promise<T> {
  const reply = (await (await fetch(`${bridge}/call`, { method: "POST", body: JSON.stringify({ method, params }) })).json()) as { ok?: T; error?: { code: ErrorCode; message: string } };
  if (reply.error) throw new BackendError(reply.error.code, reply.error.message);
  return reply.ok as T;
}

let events: EventSource | null = null;
function onBridge<T>(name: string, fn: (payload: T) => void): () => void {
  events ??= new EventSource(`${bridge}/events`);
  const listener = (e: MessageEvent<string>) => fn(JSON.parse(e.data) as T);
  events.addEventListener(name, listener);
  return () => events?.removeEventListener(name, listener);
}

/** Calls a backend method. Rejects with a `BackendError`. */
export async function call<T = unknown>(method: string, params: unknown = {}): Promise<T> {
  if (bridge) return viaBridge<T>(method, params);
  if (!inTauri) throw new BackendError("no_library", "Librarium’s backend isn’t running (this is a plain browser).");
  try {
    return await invoke<T>("call", { method, params });
  } catch (e) {
    const err = e as { code?: ErrorCode; message?: string } | string;
    throw typeof err === "object" && err?.code ? new BackendError(err.code, err.message ?? "") : new BackendError("internal", String(typeof err === "object" ? err?.message ?? e : e));
  }
}

/**
 * Listens for a backend event ("records.changed"); returns a function that stops listening.
 * Tauri's event names can't hold dots, so they travel with colons ("records:changed").
 */
export function on<T = unknown>(event: string, fn: (payload: T) => void): () => void {
  if (bridge) return onBridge(event.replaceAll(".", ":"), fn);
  if (!inTauri) return () => {};
  let off: (() => void) | null = null;
  let stopped = false;
  void listen<T>(event.replaceAll(".", ":"), (e) => fn(e.payload)).then((u) => (stopped ? u() : (off = u)));
  return () => {
    stopped = true;
    off?.();
  };
}

// ---- The menu bar ------------------------------------------------------------------------

type PredefinedItem = "Cut" | "Copy" | "Paste" | "SelectAll" | "Minimize" | "Maximize" | "Fullscreen" | "Hide" | "HideOthers" | "ShowAll" | "Services" | "About";

export type MenuEntry =
  | { kind: "item"; id: string; text: string; accelerator?: string; enabled: boolean; run: () => void }
  | { kind: "separator" }
  | { kind: "predefined"; item: PredefinedItem; text?: string };

export interface MenuSection {
  title: string;
  entries: MenuEntry[];
}

/** Installs the macOS menu bar. The first section is the app menu. */
export async function setAppMenu(sections: MenuSection[]): Promise<void> {
  if (!inTauri) return;
  const entry = (e: MenuEntry) => {
    if (e.kind === "separator") return PredefinedMenuItem.new({ item: "Separator" });
    if (e.kind === "predefined") return PredefinedMenuItem.new({ item: e.item === "About" ? { About: null } : e.item, text: e.text });
    return MenuItem.new({ id: e.id, text: e.text, accelerator: e.accelerator, enabled: e.enabled, action: e.run });
  };
  const subs = await Promise.all(sections.map(async (s) => Submenu.new({ text: s.title, items: await Promise.all(s.entries.map(entry)) })));
  await (await Menu.new({ items: subs })).setAsAppMenu();
}

// ---- Dialogs -----------------------------------------------------------------------------

/** Asks for a folder. Resolves with its path, or null. */
export async function pickFolder(title: string): Promise<string | null> {
  if (!inTauri) return null;
  const r = await openDialog({ directory: true, multiple: false, title });
  return typeof r === "string" ? r : null;
}

/** Asks for files to add. */
export async function pickFiles(title: string, extensions: string[]): Promise<string[]> {
  if (!inTauri) return [];
  const r = await openDialog({ multiple: true, title, filters: [{ name: "Library items", extensions }] });
  return Array.isArray(r) ? r : typeof r === "string" ? [r] : [];
}

/** Asks where to save an export. */
export async function pickSavePath(defaultName: string, title: string): Promise<string | null> {
  if (!inTauri) return null;
  return (await saveDialog({ title, defaultPath: defaultName })) ?? null;
}

// ---- The window --------------------------------------------------------------------------

/** Files dropped on the window, with where (in the page's coordinates). */
export function onFileDrop(handler: (paths: string[], at: { x: number; y: number }) => void, hover?: (over: boolean) => void): () => void {
  if (!inTauri) return () => {};
  let off: (() => void) | null = null;
  void getCurrentWebview()
    .onDragDropEvent((e) => {
      const p = e.payload;
      if (p.type === "drop") {
        hover?.(false);
        const ratio = window.devicePixelRatio || 1;
        handler(p.paths, { x: p.position.x / ratio, y: p.position.y / ratio });
      } else hover?.(p.type === "enter" || p.type === "over");
    })
    .then((u) => (off = u));
  return () => off?.();
}

/** A library item's original file (or a file in its folder, `name`), as bytes. */
export async function readBytes(id: string, name?: string): Promise<ArrayBuffer> {
  if (bridge) return (await fetch(`${bridge}/bytes?id=${id}${name ? `&name=${encodeURIComponent(name)}` : ""}`)).arrayBuffer();
  if (!inTauri) throw new BackendError("no_library", "Librarium’s backend isn’t running (this is a plain browser).");
  const r = await invoke<ArrayBuffer | number[]>("bytes", { id, name: name ?? null });
  return r instanceof ArrayBuffer ? r : new Uint8Array(r).buffer;
}

/** An address the webview can load a local file from (an item's original, a picture). */
export function fileUrl(path: string): string {
  if (bridge) return `${bridge}/file?path=${encodeURIComponent(path)}`;
  return inTauri ? convertFileSrc(path) : path;
}

// ---- Updates -----------------------------------------------------------------------------

/** A newer version of the app, published with `npm run release`. */
export interface AppUpdate {
  version: string;
  current: string;
  /** What is new, as written when it was published. */
  notes: string;
  /** Downloads and installs it (`progress` gets 0–1, or null when the size isn't known). */
  install(progress: (fraction: number | null) => void): Promise<void>;
}

/** Asks the release page for a newer version. Never in development: that copy isn't installed. */
export async function checkForUpdate(): Promise<AppUpdate | null> {
  if (!inTauri || import.meta.env.DEV) return null;
  const u = await check();
  if (!u) return null;
  return {
    version: u.version,
    current: u.currentVersion,
    notes: u.body ?? "",
    async install(progress) {
      let total = 0;
      let got = 0;
      await u.downloadAndInstall((e) => {
        if (e.event === "Started") total = e.data.contentLength ?? 0;
        else if (e.event === "Progress") {
          got += e.data.chunkLength;
          progress(total ? Math.min(1, got / total) : null);
        }
      });
    },
  };
}

/** The app's version ("0.2.0"). */
export async function appVersion(): Promise<string> {
  return inTauri ? getVersion() : "development";
}

/** Starts the app again (after an update); the caller has saved first. */
export async function restartApp(): Promise<void> {
  if (inTauri) await relaunch();
  else location.reload();
}
