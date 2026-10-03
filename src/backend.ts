/**
 * The ONLY file that talks to the Transport. Everything else calls the backend through here.
 *
 * API calls travel as JSON-RPC 2.0 requests through one Tauri command; events arrive on a
 * Tauri channel as JSON-RPC notifications. Errors become `BackendError {code, message, data}`.
 */
import { Channel, invoke } from "@tauri-apps/api/core";
import { Menu, MenuItem, PredefinedMenuItem, Submenu } from "@tauri-apps/api/menu";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { getCurrentWindow } from "@tauri-apps/api/window";
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
export function onCloseRequested(handler: () => Promise<void>): void {
  if (!inTauri()) {
    window.addEventListener("pagehide", () => void handler());
    return;
  }
  void getCurrentWindow().onCloseRequested(async () => {
    await handler();
  });
}
