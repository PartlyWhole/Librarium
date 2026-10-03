/**
 * The ONLY file that talks to the Transport. Everything else calls the backend through here.
 *
 * API calls travel as JSON-RPC 2.0 requests through one Tauri command; events arrive on a
 * Tauri channel as JSON-RPC notifications. Errors become `BackendError {code, message, data}`.
 */
import { Channel, invoke } from "@tauri-apps/api/core";
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
