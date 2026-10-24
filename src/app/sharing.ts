/**
 * Sharing: the sync server's address (Settings ▸ Sharing) and the connection's state, shown in
 * the status bar while an address is set. The connection itself is the backend's.
 */
import { call, on } from "../backend";
import { errorText, h, replace } from "../ui/dom";
import { effect, signal } from "../ui/signal";
import type { SharedFolderStatus, SharingStatus } from "../types";
import { confirm } from "../ui/dialog";
import { toast } from "../ui/toast";
import { router } from "./router";
import { pref } from "./prefs";

/** The name colleagues see beside this person's pointer on a shared board. */
const myName = pref("sharing.name", "");

export const sharing = signal<SharingStatus | null>(null);
void call<SharingStatus>("sharing.status").then((s) => sharing.set(s), () => {});
on<SharingStatus>("sharing.status", (s) => sharing.set(s));

/** The shared folder (Library ▸ Shared), kept by Librarium's Syncthing. */
export const sharedFolder = signal<SharedFolderStatus | null>(null);
void call<SharedFolderStatus>("sharing.folderStatus").then((s) => sharedFolder.set(s), () => {});
on<SharedFolderStatus>("sharing.folder", (s) => sharedFolder.set(s));
/** Whether this Mac joined with a code (the shared folder is then kept while a library is open). */
const joined = signal(false);
void call<string>("sharing.invite").then(() => joined.set(true), () => joined.set(false));

const FOLDER_STATE: Record<string, string> = { starting: "Starting…", waiting: "Waiting for the sync server", syncing: "Fetching", ready: "Up to date", error: "Not kept in step" };

/** What the shared folder is doing, in words. */
function folderLine(s: SharedFolderStatus): string {
  if (s.state === "syncing") return `Fetching ${s.need} ${s.need === 1 ? "file" : "files"}…`;
  return s.detail && s.state !== "ready" ? s.detail : (FOLDER_STATE[s.state] ?? s.state);
}

/** Settings ▸ Sharing's Shared folder: Join with a code, or how it's doing, Invite and Leave. */
function renderFolder(host: HTMLElement): () => void {
  const code = h("input", { type: "text", id: "join-code", placeholder: "librarium-join:…", spellcheck: false, autocomplete: "off" }) as HTMLInputElement;
  const problem = h("p", { class: "small sharing-warning", hidden: true });
  const join = async () => {
    problem.hidden = true;
    try {
      sharedFolder.set(await call<SharedFolderStatus>("sharing.join", { code: code.value }));
      sharing.set(await call<SharingStatus>("sharing.status"));
      joined.set(true);
      code.value = "";
    } catch (e) {
      problem.textContent = errorText(e);
      problem.hidden = false;
    }
  };
  code.addEventListener("keydown", (e) => e.key === "Enter" && void join());
  const invite = async () => {
    try {
      const c = await call<string>("sharing.invite");
      await navigator.clipboard.writeText(c).then(() => toast("Join code copied. A colleague pastes it in Settings ▸ Sharing (after joining your Tailscale network)."), () => toast(c));
    } catch (e) {
      toast(errorText(e));
    }
  };
  const leave = async () => {
    const ok = await confirm("Stop sharing the folder on this Mac?", "Library ▸ Shared stays here with everything in it, as an ordinary folder, and colleagues keep theirs. Nothing is deleted.", "Stop sharing");
    if (!ok) return;
    try {
      sharedFolder.set(await call<SharedFolderStatus>("sharing.leave"));
      joined.set(false);
    } catch (e) {
      toast(errorText(e));
    }
  };
  return effect(() => {
    const s = sharedFolder();
    replace(host,
      h("h3", { class: "sharing-sub" }, "Shared folder"),
      h("p", { class: "muted small" }, "Library ▸ Shared is kept the same on colleagues’ Macs, through your sync server. What you put there, they get."),
      joined()
        ? [
            s ? h("p", { class: "small sharing-state" }, h("span", { class: `sharing-dot ${s.state === "ready" ? "connected" : s.state === "error" || s.state === "waiting" ? "offline" : "connecting"}`, "aria-hidden": "true" }), folderLine(s)) : null,
            h("div", { class: "row" },
              h("button", { class: "button", type: "button", onclick: () => void invite() }, "Invite a colleague"),
              h("button", { class: "button", type: "button", onclick: () => void leave() }, "Stop sharing the folder")),
          ]
        : [
            h("div", { class: "field" }, h("label", { for: "join-code" }, "Join code"), code),
            problem,
            h("div", { class: "row" }, h("button", { class: "button primary", type: "button", onclick: () => void join() }, "Join")),
            h("p", { class: "muted small" }, "The code comes from your sync server’s setup, or from a colleague’s Invite. Joining also sets the sync server above."),
          ]);
  });
}

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
  const folderHost = h("div", { class: "sharing-folder" });
  const name = h("input", { type: "text", id: "sharing-name", placeholder: "How colleagues see you", value: myName.peek(), autocomplete: "name" }) as HTMLInputElement;
  name.addEventListener("change", () => myName.set(name.value.trim()));
  replace(host,
    h("p", { class: "muted small" }, "Share boards with colleagues through a sync server you run, reachable only on your private network. While this is empty, Librarium connects nowhere."),
    h("div", { class: "field" }, h("label", { for: "sync-server" }, "Sync server"), input),
    problem, state,
    h("div", { class: "field" }, h("label", { for: "sharing-name" }, "Your name"), name),
    h("p", { class: "muted small" }, "Shown to colleagues beside your pointer on a shared board."),
    folderHost);
  const stopFolder = renderFolder(folderHost);
  return () => (stop(), stopFolder());
}
