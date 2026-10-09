/**
 * Save web pages…: one or more addresses, each saved by a background job (`library.savePage`)
 * into the Library folder being viewed. Pages already in the library are counted and skipped,
 * unless a new snapshot of them is asked for.
 */
import { call } from "../backend";
import { defineAction } from "../app/actions";
import { isOpen } from "../app/library";
import { listRecords } from "../app/records";
import { showStatus } from "../app/status";
import { modal } from "../ui/dialog";
import { h } from "../ui/dom";
import { untracked } from "../ui/signal";
import { toast } from "../ui/toast";
import type { RecordInfo } from "../types";
import { libraryHere } from "../library";
import { Globe } from "lucide";
import "./websave.css";

/** The distinct http(s) addresses in some text (one per line, or anywhere in it). */
export function webAddresses(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/https?:\/\/[^\s<>"'\]]+/gi)) {
    // Trailing punctuation belongs to the sentence, and ")" too unless it closes a "(" inside.
    let url = m[0];
    for (;;) {
      if (/[.,;:!?]$/.test(url)) url = url.slice(0, -1);
      else if (url.endsWith(")") && (url.match(/\(/g)?.length ?? 0) < (url.match(/\)/g)?.length ?? 0)) url = url.slice(0, -1);
      else break;
    }
    if (URL.canParse(url) && !out.includes(url)) out.push(url);
  }
  return out;
}

/** An address as the backend compares it: without its #fragment and trailing slash. */
const normal = (u: string) => (u.split("#")[0] ?? "").replace(/\/+$/, "");

/** The addresses saved pages came from, as given and after redirects. */
function savedAddresses(items: RecordInfo[]): Set<string> {
  const out = new Set<string>();
  for (const i of items) {
    const p = i.fields.provenance as { source?: string; "final-url"?: string } | undefined;
    for (const u of [p?.source, p?.["final-url"]]) if (u) out.add(normal(u));
  }
  return out;
}

/** Queues one job per address; says how it went. */
async function save(urls: string[], folder: string): Promise<void> {
  let queued = 0;
  const failed: string[] = [];
  for (const url of urls) {
    try {
      await call("library.savePage", { url, hide: ["archive.at"], folder: folder || null });
      queued++;
    } catch {
      failed.push(url);
    }
  }
  if (queued) showStatus(queued === 1 ? `Saving ${urls[0]}…` : `Saving ${queued} pages in the background; the Jobs view shows how far it has got.`, 8000);
  if (failed.length) toast(`${failed.length} couldn’t be queued: ${failed.slice(0, 3).join(", ")}${failed.length > 3 ? "…" : ""}`);
}

function openDialog(): void {
  const folder = libraryHere();
  const saved = savedAddresses(untracked(() => listRecords("item")));
  const input = h("textarea", { class: "links-input", rows: 4, placeholder: "https://…\nOne address per line, or paste a whole list.", "aria-label": "Addresses of the pages to save", spellcheck: false });
  const summary = h("p", { class: "muted small", "aria-live": "polite" });
  const again = h("input", { type: "checkbox" });
  const againRow = h("label", { class: "check-row small", hidden: true }, again, " Save a new snapshot of those too");
  const split = () => {
    const all = webAddresses(input.value);
    const known = all.filter((u) => saved.has(normal(u)));
    return { all, known, todo: again.checked ? all : all.filter((u) => !saved.has(normal(u))) };
  };
  const update = () => {
    const { all, known } = split();
    againRow.hidden = !known.length;
    summary.textContent = [all.length > 1 ? `${all.length} pages` : "", known.length ? `${known.length} already in your library${again.checked ? "" : " (skipped)"}` : ""].filter(Boolean).join(" · ");
  };
  const go = () => {
    const { all, todo } = split();
    if (!all.length) return toast("There’s no web address (http or https) there.");
    m.close();
    if (!todo.length) return showStatus(all.length === 1 ? "That page is already in your library." : "All of those pages are already in your library.", 6000);
    void save(todo, folder);
  };
  input.addEventListener("input", update);
  again.addEventListener("change", update);
  input.addEventListener("keydown", (e) => {
    // Enter saves a single address; with a list, ⌘↩ saves.
    if (e.key === "Enter" && !e.isComposing && (e.metaKey || e.ctrlKey || !input.value.includes("\n"))) {
      e.preventDefault();
      e.stopPropagation();
      go();
    }
  });
  const m = modal(
    h("div", { class: "ask" },
      h("h2", { class: "ask-title" }, "Save web pages"),
      h("p", { class: "muted small" }, "Librarium keeps a faithful PDF of each page and its clean text, with where and when it came from. Pages are saved one after another in the background.", folder ? ` New pages go into “${folder.split("/").pop()}”.` : ""),
      input, summary, againRow,
      h("div", { class: "ask-buttons" },
        h("button", { class: "button", type: "button", onclick: () => m.close() }, "Cancel"),
        h("button", { class: "button primary", type: "button", title: "Save (⌘↩)", onclick: go }, "Save"))),
    { label: "Save web pages" },
  );
  input.focus();
}

defineAction({
  id: "library.savePages",
  title: "Save web pages…",
  when: isOpen,
  menu: { name: "file", group: 1.2 },
  icon: Globe,
  run: openDialog,
});
