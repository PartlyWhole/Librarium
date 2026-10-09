/** Brief, inverted toasts at the bottom centre, announced politely. One at a time. */
import { h } from "./dom";

export interface ToastOptions {
  action?: { label: string; run: () => void };
  ms?: number;
}

let host: HTMLElement | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;

export function toast(message: string, opts: ToastOptions = {}): void {
  if (!host?.isConnected) document.body.appendChild((host = h("div", { class: "toast-host", role: "status", "aria-live": "polite" })));
  const el = host;
  clearTimeout(timer);
  const dismiss = () => el.replaceChildren();
  const { action } = opts;
  const button = action
    ? h("button", { class: "toast-action", onclick: () => (dismiss(), action.run()) }, action.label)
    : null;
  el.replaceChildren(h("div", { class: "toast" }, h("span", null, message), button));
  timer = setTimeout(dismiss, opts.ms ?? (action ? 6000 : 3000));
}
