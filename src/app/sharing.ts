/**
 * Sharing: the sync server's address (Settings ▸ Sharing) and the connection's state, shown in
 * the status bar while an address is set. The connection itself is the backend's.
 */
import { call, on } from "../backend";
import { errorText, h, replace } from "../ui/dom";
import { effect, signal } from "../ui/signal";
import type { SharingStatus } from "../types";
import { router } from "./router";
import { pref } from "./prefs";

/** The name colleagues see beside this person's pointer on a shared board. */
const myName = pref("sharing.name", "");

export const sharing = signal<SharingStatus | null>(null);
void call<SharingStatus>("sharing.status").then((s) => sharing.set(s), () => {});
on<SharingStatus>("sharing.status", (s) => sharing.set(s));

const STATE: Record<string, string> = { connecting: "Connecting…", connected: "Connected", offline: "Offline" };

/** The status bar's word on sharing: nothing while no server is set. */
export function sharingStatus(): HTMLElement {
  const el = h("div", { class: "status-sharing", role: "status", "aria-live": "polite" });
  effect(() => {
    const s = sharing();
    replace(el, !s || s.state === "off" ? null : h("button", { class: "status-link", type: "button", title: s.error ?? `Sync server: ${s.server}`, onclick: () => router.go("settings") },
      h("span", { class: `sharing-dot ${s.state}`, "aria-hidden": "true" }), `Sharing: ${STATE[s.state] ?? s.state}`));
  });
  return el;
}

/** Settings ▸ Sharing: the address, Connect / Stop sharing, and how the connection is. */
export function renderSharingSettings(host: HTMLElement): () => void {
  const input = h("input", { type: "text", id: "sync-server", placeholder: "https://name.your-tailnet.ts.net:8443", spellcheck: false, autocomplete: "off" }) as HTMLInputElement;
  input.value = sharing.peek()?.server ?? "";
  const problem = h("p", { class: "small sharing-warning", hidden: true });
  const set = async (server: string | null) => {
    problem.hidden = true;
    try {
      sharing.set(await call<SharingStatus>("sharing.setServer", { server }));
      if (server === null) input.value = "";
    } catch (e) {
      problem.textContent = errorText(e);
      problem.hidden = false;
    }
  };
  input.addEventListener("keydown", (e) => e.key === "Enter" && void set(input.value));
  const state = h("div");
  const stop = effect(() => {
    const s = sharing();
    const active = !!s && s.state !== "off";
    replace(state,
      active ? h("p", { class: "small sharing-state" }, h("span", { class: `sharing-dot ${s.state}`, "aria-hidden": "true" }), s.state === "connected" ? `Connected to ${s.server}` : (s.error ?? STATE[s.state])) : null,
      active && !s.private ? h("p", { class: "small sharing-warning" }, "This server is on the public internet. Anyone who finds it can read and change what’s shared on it. A server reachable only on your private network (Tailscale) is safer.") : null,
      h("div", { class: "row" },
        h("button", { class: "button primary", type: "button", onclick: () => void set(input.value) }, active ? "Connect to this address" : "Connect"),
        active ? h("button", { class: "button", type: "button", onclick: () => void set(null) }, "Stop sharing") : null));
  });
  const name = h("input", { type: "text", id: "sharing-name", placeholder: "How colleagues see you", value: myName.peek(), autocomplete: "name" }) as HTMLInputElement;
  name.addEventListener("change", () => myName.set(name.value.trim()));
  replace(host,
    h("p", { class: "muted small" }, "Share boards with colleagues through a sync server you run, reachable only on your private network. While this is empty, Librarium connects nowhere."),
    h("div", { class: "field" }, h("label", { for: "sync-server" }, "Sync server"), input),
    problem, state,
    h("div", { class: "field" }, h("label", { for: "sharing-name" }, "Your name"), name),
    h("p", { class: "muted small" }, "Shown to colleagues beside your pointer on a shared board."));
  return stop;
}
