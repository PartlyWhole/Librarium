/**
 * The library folder: its state, choosing it, and the pages shown while it isn't open
 * (Welcome, Opening, the folder missing, opening failed).
 */
import { call, on, pickFolder } from "../backend";
import { ask } from "../ui/dialog";
import { errorText, h, replace } from "../ui/dom";
import { count } from "../ui/format";
import { logo } from "../ui/logo";
import { effect, signal } from "../ui/signal";
import { toast } from "../ui/toast";
import type { FolderInfo, LibraryStatus } from "../types";
import { pref } from "./prefs";

export const library = signal<LibraryStatus | null>(null);
export const isOpen = () => library()?.state === "open";

on<LibraryStatus>("library.status", (st) => library.set(st));

/** Asks the backend where things stand; `retry` opens a missing or failed folder again. */
export async function refreshLibrary(retry = false): Promise<void> {
  try {
    let st = await call<LibraryStatus>("folder.status");
    if (retry && st.path && (st.state === "missing" || st.state === "failed")) {
      st = await call<LibraryStatus>("folder.open", { path: st.path }).catch(() => call<LibraryStatus>("folder.status"));
    }
    library.set(st);
  } catch (e) {
    library.set({ state: "failed", path: library.peek()?.path ?? null, id: null, in_icloud: false, store: null, error: errorText(e) });
  }
}

/** Asks for a folder, checks it (a folder with files in it, iCloud), then opens it. */
export async function chooseFolder(): Promise<void> {
  const path = await pickFolder("Choose the library folder");
  if (!path) return;
  const info = await call<FolderInfo>("folder.inspect", { path });
  const name = path.split("/").pop() || path;
  if (!info.is_library && !info.empty) {
    const md = info.markdown_files ? `, including ${count(Number(info.markdown_files), "Markdown file")}` : "";
    const choice = await ask("Use a folder that already has files?",
      h("p", null, `“${name}” already holds files${md}. Librarium leaves them where they are and adds its own folders: notes, captures, items and .librarium. Markdown files inside notes become notes.`),
      [{ label: "Choose another…", value: "other" }, { label: "Use this folder", value: "use", primary: true }]);
    if (choice === "other") return chooseFolder();
    if (choice !== "use") return;
  }
  const noted = pref("ui.icloudNoted", false);
  if (info.in_icloud && !noted.peek()) {
    await ask("This folder is in iCloud Drive", h("p", null, "Your notes will sync through iCloud. Librarium’s own data — its index, drafts and unfinished work — stays on this Mac, outside iCloud."), [{ label: "Continue", value: true, primary: true }]);
    noted.set(true);
  }
  try {
    library.set(await call<LibraryStatus>("folder.open", { path }));
  } catch (e) {
    toast(errorText(e));
    await refreshLibrary();
  }
}

const button = (label: string, run: () => void, primary = false) => h("button", { class: `button${primary ? " primary" : ""}`, onclick: run }, label);
const choose = () => void chooseFolder();
const retry = () => void refreshLibrary(true);

/** The page shown while no library is open, following the library's state. */
export function renderStart(host: HTMLElement): () => void {
  return effect(() => {
    const st = library();
    const title = (t: string) => h("h1", { class: "page-title" }, t);
    // Not known yet: nothing, rather than a welcome that turns out wrong.
    if (!st) replace(host);
    else if (st.state === "opening") replace(host, title("Opening your library"), h("p", { class: "muted" }, "Checking the folder for changes made while Librarium was closed…"));
    else if (st.state === "missing") {
      replace(host, title("The library folder can’t be found"), h("p", null, `“${st.path}” isn’t there. It may be on a drive that isn’t connected right now.`),
        h("div", { class: "row" }, button("Locate it…", choose, true), button("Choose another folder…", choose), button("Try again", retry)));
    } else if (st.state === "failed") {
      replace(host, title("The library couldn’t be opened"), h("p", null, st.error ?? ""), h("div", { class: "row" }, button("Choose a folder…", choose, true), button("Try again", retry)));
    } else {
      replace(host, logo(72), title("Welcome to Librarium"), h("p", null, "Everything you write and keep lives as plain files in a folder you choose, readable without this app."), h("div", { class: "row" }, button("Choose a folder…", choose, true)));
    }
  });
}
