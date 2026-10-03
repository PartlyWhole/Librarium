/** Brief, inverted toasts at the bottom centre, announced politely. One at a time. */
import { h } from "./dom";

export interface ToastOptions {
  action?: { label: string; run: () => void };
  ms?: number;
}

let host: HTMLElement | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;

function ensureHost(): HTMLElement {
  if (host && host.isConnected) return host;
  host = h("div", { class: "toast-host", role: "status", "aria-live": "polite" });
  document.body.appendChild(host);
  return host;
}

export function toast(message: string, opts: ToastOptions = {}): void {
  const el = ensureHost();
  clearTimeout(timer);
  const dismiss = () => el.replaceChildren();
  const action = opts.action
    ? h("button", {
        class: "toast-action",
        onclick: () => {
          dismiss();
          opts.action!.run();
        },
      }, opts.action.label)
    : null;
  el.replaceChildren(h("div", { class: "toast" }, h("span", null, message), action));
  timer = setTimeout(dismiss, opts.ms ?? (opts.action ? 6000 : 3000));
}
