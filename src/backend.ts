/**
 * The ONLY file that talks to the Transport. Everything else calls the backend through here.
 *
 * API calls travel as JSON-RPC 2.0 requests through one Tauri command; events arrive on a
 * Tauri channel as JSON-RPC notifications. Errors become `BackendError {code, message, data}`.
 */
import { Channel, invoke } from "@tauri-apps/api/core";
import { Menu, MenuItem, PredefinedMenuItem, Submenu } from "@tauri-apps/api/menu";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { check } from "@tauri-apps/plugin-updater";
import { getVersion } from "@tauri-apps/api/app";
import type { BackendError } from "./generated/BackendError";
import type { RpcNotification } from "./generated/RpcNotification";
import type { RpcRequest } from "./generated/RpcRequest";
import type { RpcResponse } from "./generated/RpcResponse";

export type { BackendError };

export class BackendCallError extends Error implements BackendError {
  code: BackendError["code"];
  data: unknown;
  constructor(e: BackendError) {
    super(e.message);
    this.name = "BackendError";
    this.code = e.code;
    this.data = e.data;
  }
}

let nextId = 1;

/** Calls an API method. Rejects with a `BackendCallError`. */
export async function call<T>(method: string, params: unknown = null): Promise<T> {
  const request: RpcRequest = { jsonrpc: "2.0", id: nextId++, method, params };
  let response: RpcResponse;
  try {
    response = await invoke<RpcResponse>("rpc", { request });
  } catch (e) {
    throw new BackendCallError({ code: "internal", message: String(e), data: null });
  }
  if (response.error) {
    throw new BackendCallError(response.error.data ?? { code: "internal", message: response.error.message, data: null });
  }
  return response.result as T;
}

type Listener = (params: unknown) => void;
const listeners = new Map<string, Set<Listener>>();
let subscribed: Promise<void> | null = null;

/** Listens for backend notifications (events carry IDs and a sequence number). */
export function on(method: string, fn: Listener): () => void {
  let set = listeners.get(method);
  if (!set) listeners.set(method, (set = new Set()));
  set.add(fn);
  subscribed ??= subscribe();
  return () => set.delete(fn);
}

async function subscribe(): Promise<void> {
  const channel = new Channel<RpcNotification>();
  channel.onmessage = (n) => {
    for (const fn of listeners.get(n.method) ?? []) fn(n.params);
  };
  await invoke("subscribe", { channel });
}

/** True inside the Tauri webview; false in plain browsers and tests. */
export function inTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

// ---- Native menu and dialogs: still the one door to Tauri. ----------------------------------


export type PredefinedItem = "Undo" | "Redo" | "Cut" | "Copy" | "Paste" | "SelectAll" | "Minimize" | "Maximize" | "Fullscreen" | "CloseWindow" | "Hide" | "HideOthers" | "ShowAll" | "Quit" | "Services" | "About";

export type MenuEntry =
  | { kind: "item"; id: string; text: string; accelerator?: string; enabled: boolean; run: () => void }
  | { kind: "separator" }
  | { kind: "predefined"; item: PredefinedItem; text?: string };

export interface MenuSection {
  title: string;
  entries: MenuEntry[];
}

/** Installs the macOS menu bar. The first section is the App menu. */
export async function setAppMenu(sections: MenuSection[]): Promise<void> {
  if (!inTauri()) return;
  const subs = await Promise.all(
    sections.map(async (s) => {
      const items = await Promise.all(
        s.entries.map((e) => {
          if (e.kind === "separator") return PredefinedMenuItem.new({ item: "Separator" });
          if (e.kind === "predefined") {
            if (e.item === "About") return PredefinedMenuItem.new({ item: { About: null }, text: e.text });
            return PredefinedMenuItem.new({ item: e.item, text: e.text });
          }
          return MenuItem.new({ id: e.id, text: e.text, accelerator: e.accelerator, enabled: e.enabled, action: () => e.run() });
        }),
      );
      return Submenu.new({ text: s.title, items });
    }),
  );
  const menu = await Menu.new({ items: subs });
  await menu.setAsAppMenu();
}

/** Asks the user to choose a folder. Resolves with its path, or null. */
export async function pickFolder(title: string): Promise<string | null> {
  if (!inTauri()) return null;
  const r = await openDialog({ directory: true, multiple: false, title });
  return typeof r === "string" ? r : null;
}


/** Runs `handler` (e.g. a last save) before the window closes. */
/** Closes the window (as ⇧⌘W does; the close request still saves first). */
export async function closeWindow(): Promise<void> {
  if (inTauri()) await getCurrentWindow().close();
}

export function onCloseRequested(handler: () => Promise<void>): void {
  if (!inTauri()) {
    window.addEventListener("pagehide", () => void handler());
    return;
  }
  void getCurrentWindow().onCloseRequested(async () => {
    await handler();
  });
}

/** A record's file as raw bytes (an item's original, for the reader). */
export async function readBytes(id: string, name?: string): Promise<ArrayBuffer> {
  const r = await invoke<ArrayBuffer>("bytes", { id, name: name ?? null });
  return r instanceof ArrayBuffer ? r : new Uint8Array(r as unknown as number[]).buffer;
}

/** Asks the user to choose files to add. */
export async function pickFiles(title: string, extensions: string[]): Promise<string[]> {
  if (!inTauri()) return [];
  const r = await openDialog({ multiple: true, title, filters: [{ name: "Library items", extensions }] });
  return Array.isArray(r) ? r : typeof r === "string" ? [r] : [];
}

/** Files dropped on the window, with where (in the page's coordinates). */
export function onFileDrop(handler: (paths: string[], at: { x: number; y: number }) => void, hover?: (over: boolean) => void): () => void {
  if (!inTauri()) return () => {};
  let off: (() => void) | null = null;
  void getCurrentWebview()
    .onDragDropEvent((e) => {
      if (e.payload.type === "drop") {
        hover?.(false);
        const ratio = window.devicePixelRatio || 1;
        handler(e.payload.paths, { x: e.payload.position.x / ratio, y: e.payload.position.y / ratio });
      } else if (e.payload.type === "enter" || e.payload.type === "over") hover?.(true);
      else hover?.(false);
    })
    .then((u) => (off = u));
  return () => off?.();
}

/** Asks where to save an export. */
export async function pickSavePath(defaultName: string, title: string): Promise<string | null> {
  if (!inTauri()) return null;
  return (await saveDialog({ title, defaultPath: defaultName })) ?? null;
}

// ---- Updates (R-069, 0072) ---------------------------------------------------------------------

/** A newer version of the app, published with `npm run release`. */
export interface AppUpdate {
  version: string;
  current: string;
  /** What is new, as written when it was published. */
  notes: string;
  /** Downloads and installs it (`progress` gets 0–1, or null when the size isn't known). */
  install(progress: (fraction: number | null) => void): Promise<void>;
}

/**
 * Asks the release page whether a newer version is published. Never in development: the app
 * running from the working tree is not an installed copy to replace.
 */
export async function checkForUpdate(): Promise<AppUpdate | null> {
  if (!inTauri() || import.meta.env.DEV) return null;
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
  return inTauri() ? getVersion() : "development";
}

/** Quits the app; the caller has saved its work first (R-071). */
export async function quitApp(): Promise<void> {
  if (inTauri()) await invoke("quit");
}

/** Restarts the app (after an update), finishing as closing the window does. */
export async function restartApp(): Promise<void> {
  if (inTauri()) await invoke("restart");
  else location.reload();
}
