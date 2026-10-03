/** Library: saved pages, PDFs, images and EPUBs, read in one reader. */
import { call, onFileDrop, pickFiles, readBytes } from "../../backend";
import { h, replace } from "../../kit/dom";
import { icon } from "../../kit/icon";
import { effect, signal } from "../../kit/signal";
import { toast } from "../../kit/toast";
import { isMenuKey, menuPointFor } from "../../kit/menu";
import { count } from "../../kit/format";
import type { ShellApi } from "../../shell/api";
import { READER_TOOLS, type ReaderTool } from "../../shell/slots";
import type { StoredText as StoredJoined } from "../../generated/StoredText";
import type { RecordInfo } from "../../generated/RecordInfo";
import type { Written } from "../../generated/Written";
import type { ReaderView, StoredText } from "../../reader/host";
import { pdfEngine } from "../../reader/pdf";
import { imageEngine } from "../../reader/image";
import { epubEngine } from "../../reader/epub";
import { modal } from "../../kit/dialog";
import { BookOpen, Globe, FileText, Image as ImageIcon, Library as LibraryIcon, Plus, ZoomIn, ZoomOut, Maximize, ChevronUp, ChevronDown } from "lucide";

const KIND = "item";
const EXTENSIONS = ["pdf", "epub", "png", "jpg", "jpeg", "gif", "webp", "heic", "tif", "tiff"];

function formatOf(r: RecordInfo): string {
  return String(r.fields["library.format"] ?? "");
}

function iconFor(r: RecordInfo) {
  const f = formatOf(r);
  return f === "image" ? ImageIcon : f === "epub" ? BookOpen : f === "web" ? Globe : FileText;
}

interface ImportResult {
  imported: Written[];
  failed: { path: string; error: string }[];
}

function snapshotLabel(at: string): string {
  // "2026-10-02T091400Z" → a short local date and time.
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(at);
  if (!m) return at;
  const d = new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!));
  return d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export function library(shell: ShellApi): void {
  shell.openers.add("library", KIND, "item");
  for (const e of [pdfEngine, epubEngine, imageEngine]) shell.readerEngines.add("library", e.id, e);

  const importPaths = async (paths: string[]) => {
    if (!paths.length) return;
    shell.status.show(`Adding ${count(paths.length, "file")}…`, 0);
    try {
      const r = await call<ImportResult>("library.import", { paths });
      for (const w of r.imported) shell.records.put(w.info, w.seq);
      shell.status.show(r.imported.length ? `Added ${count(r.imported.length, "item")}.` : "");
      for (const f of r.failed) toast(f.error);
      if (r.imported.length === 1) shell.openRecord(r.imported[0]!.info.id);
    } catch (e) {
      shell.status.show("");
      toast(String((e as { message?: string }).message ?? e));
    }
  };

  shell.actions.add("library", {
    id: "library.savePage",
    title: "Save web pages…",
    when: () => shell.folder()?.state === "open",
    menu: { name: "file", group: 1 },
    icon: Globe,
    run: () => {
      const input = h("textarea", { class: "combo-input links-input", rows: 4, placeholder: "https://…\nOne address per line, or paste a whole list.", "aria-label": "Addresses of the pages to save", spellcheck: false }) as HTMLTextAreaElement;
      const count = h("p", { class: "muted small", "aria-live": "polite" });
      // Pages already in the library are skipped, unless a fresh snapshot of them is wanted.
      const again = h("input", { type: "checkbox" }) as HTMLInputElement;
      const againRow = h("label", { class: "check-row small", hidden: true }, again, " Save a new snapshot of those too");
      const saved = savedAddresses(shell.records.list(KIND));
      const split = () => {
        const all = webAddresses(input.value);
        const known = all.filter((u) => saved.has(normalizeAddress(u)));
        return { all, known, todo: again.checked ? all : all.filter((u) => !saved.has(normalizeAddress(u))) };
      };
      const update = () => {
        const { all, known } = split();
        againRow.hidden = !known.length;
        count.textContent = [all.length > 1 ? `${all.length} pages` : "", known.length ? `${known.length} already in your library${again.checked ? "" : " (skipped)"}` : ""].filter(Boolean).join(" · ");
      };
      input.addEventListener("input", update);
      again.addEventListener("change", update);
      const go = async () => {
        const { all, todo: urls } = split();
        if (!all.length) return toast("There’s no web address (http or https) there.");
        if (!urls.length) {
          m.close();
          return shell.status.show(all.length === 1 ? "That page is already in your library." : "All of those pages are already in your library.", 6000);
        }
        m.close();
        let queued = 0;
        const failed: string[] = [];
        for (const url of urls) {
          try {
            await call("library.savePage", { url });
            queued++;
          } catch {
            failed.push(url);
          }
        }
        shell.status.show(queued === 1 ? `Saving ${urls[0]}…` : `Saving ${queued} pages in the background; the jobs list shows how far it has got.`, 8000);
        if (failed.length) toast(`${failed.length} couldn’t be queued: ${failed.slice(0, 3).join(", ")}${failed.length > 3 ? "…" : ""}`);
      };
      input.addEventListener("keydown", (e) => {
        // Enter saves a single address; with a list, ⌘↩ saves.
        if (e.key === "Enter" && !e.isComposing && (e.metaKey || e.ctrlKey || !input.value.includes("\n"))) {
          e.preventDefault();
          e.stopPropagation();
          void go();
        }
      });
      const m = modal(h("div", { class: "ask" }, h("h2", { class: "ask-title" }, "Save web pages"), h("p", { class: "muted small" }, "Librarium keeps a faithful PDF of each page and its clean text, with where and when it came from. Pages are saved one after another in the background."), input, count, againRow, h("div", { class: "ask-buttons" }, h("button", { class: "button", onclick: () => m.close() }, "Cancel"), h("button", { class: "button primary", title: "Save (⌘↩)", onclick: () => void go() }, "Save"))), { label: "Save web pages" });
      input.focus();
    },
  });

  shell.actions.add("library", {
    id: "library.add",
    title: "Add to library…",
    when: () => shell.folder()?.state === "open",
    menu: { name: "file", group: 1 },
    icon: Plus,
    run: async () => importPaths(await pickFiles("Add to the library", EXTENSIONS)),
  });

  // Files dropped anywhere on the window are added.
  const dropping = signal(false);
  onFileDrop((paths) => void importPaths(paths), (over) => dropping.set(over));
  effect(() => document.body.classList.toggle("dropping", dropping()));

  shell.pages.add("library", "library", {
    id: "library",
    title: "Library",
    icon: LibraryIcon,
    ribbon: 2,
    render(host, _p, ctx) {
      ctx.setHeaderActions([h("button", { class: "icon-button", "aria-label": "Add to library", title: "Add to library", onclick: () => shell.actions.run("library.add") }, icon(Plus))]);
      return effect(() => {
        const items = shell.records.list(KIND).sort((a, b) => a.title.localeCompare(b.title));
        replace(
          host,
          h("h1", { class: "page-title" }, "Library"),
          items.length
            ? h("ul", { class: "item-list" }, items.map((i) => h("li", { oncontextmenu: (e: MouseEvent) => (e.preventDefault(), shell.showRecordMenu(i, { x: e.clientX, y: e.clientY })) }, h("a", { href: "#", class: "item-link", onclick: (e: Event) => (e.preventDefault(), shell.openRecord(i.id)), onkeydown: (e: KeyboardEvent) => isMenuKey(e) && (e.preventDefault(), shell.showRecordMenu(i, menuPointFor(e.target as Element))) }, icon(iconFor(i), 16), h("span", null, i.title || "Untitled"), h("span", { class: "muted small" }, i.fields["library.pages"] ? count(Number(i.fields["library.pages"]), formatOf(i) === "epub" ? "chapter" : "page") : "")))))
            : h("p", { class: "empty" }, "No library items yet. Add PDFs, images or EPUBs, or drop them on the window."),
        );
      });
    },
  });

  shell.pages.add("library", "item", {
    id: "item",
    title: "Item",
    icon: BookOpen,
    render(host, params, ctx) {
      const id = params.id ?? "";
      const r = shell.records.get(id);
      if (!r) {
        replace(host, h("p", { class: "empty" }, "This item can’t be found any more."));
        return;
      }
      ctx.setTitle(r.title || "Untitled");
      host.classList.add("reader-page");
      // A saved web page reads as its snapshot's PDF.
      const web = formatOf(r) === "web";
      const snapshots = (Array.isArray(r.fields["library.snapshots"]) ? r.fields["library.snapshots"] : []) as { at: string; checks?: { kind: string; reason: string }[]; "final-url"?: string }[];
      const snap = params.snapshot ?? String(r.fields["library.snapshot"] ?? "");
      const engine = shell.readerEngines.values().find((e) => e.formats.includes(web ? "pdf" : formatOf(r)));
      const stage = h("div", { class: "reader-stage" });
      const pos = h("span", { class: "reader-pos muted small", "aria-live": "polite" });
      const findInput = h("input", { class: "find-input", type: "search", placeholder: "Find", "aria-label": "Find in this item", spellcheck: false });
      const findCount = h("span", { class: "muted small find-count", "aria-live": "polite" });
      let view: ReaderView | null = null;
      let alive = true;
      const btn = (node: Parameters<typeof icon>[0], label: string, run: () => void) => h("button", { class: "icon-button", "aria-label": label, title: label, onclick: run }, icon(node));
      const find = async (again = false, back = false) => {
        const q = findInput.value.trim();
        if (!view || !q) {
          view?.findClear();
          findCount.textContent = "";
          return;
        }
        const res = await view.find(q, { again, back });
        findCount.textContent = res.count ? `${res.current} of ${res.count}` : "Not found";
      };
      findInput.addEventListener("keydown", (e) => {
        if (e.isComposing) return;
        if (e.key === "Enter") {
          e.preventDefault();
          void find(true, e.shiftKey);
        } else if (e.key === "Escape") {
          findInput.value = "";
          void find();
        }
      });
      findInput.addEventListener("input", () => void find());
      const tools = h("span", { class: "reader-tools" });
      const toolbar = h("div", { class: "reader-toolbar", role: "toolbar", "aria-label": "Reader" },
        btn(ZoomOut, "Zoom out", () => view?.zoomOut()), btn(Maximize, "Fit to width", () => view?.zoomReset()), btn(ZoomIn, "Zoom in", () => view?.zoomIn()),
        pos, tools, h("span", { class: "spacer" }), findInput, findCount, btn(ChevronUp, "Previous match", () => void find(true, true)), btn(ChevronDown, "Next match", () => void find(true)));
      const toolDisposers: (() => void)[] = [];
      const notices = h("div", { class: "reader-notices" });
      if (web) {
        const current = snapshots.find((s) => s.at === snap);
        for (const c of current?.checks ?? []) notices.appendChild(h("p", { class: "notice" }, `About this snapshot: ${c.reason}`));
        if (snapshots.length > 1) {
          const pick = h("select", { "aria-label": "Snapshot", onchange: () => shell.router.go("item", { id, snapshot: pick.value }, { replace: true }) }, snapshots.map((s) => h("option", { value: s.at, selected: s.at === snap }, snapshotLabel(s.at))));
          tools.before(pick);
        }
      }
      // A column beside the document, for tools' panels (making a capture…).
      const aside = h("aside", { class: "reader-aside", hidden: true });
      new MutationObserver(() => (aside.hidden = !aside.childElementCount)).observe(aside, { childList: true });
      replace(host, toolbar, notices, h("div", { class: "reader-body" }, stage, aside));
      if (!engine) {
        replace(stage, h("p", { class: "empty" }, "This kind of item can’t be shown here yet."));
        return;
      }
      void engine
        .open(stage, { id, format: web ? "pdf" : formatOf(r), title: r.title, bytes: () => readBytes(id, web ? `snapshots/${snap}/page.pdf` : undefined), text: () => (web ? Promise.resolve(null) : call<StoredText | null>("library.text", { id })) }, {
          moved: () => (pos.textContent = view?.position() ?? ""),
          firstPaint: (ms) => console.info(`reader: first page of ${formatOf(r)} in ${Math.round(ms)} ms`),
        })
        .then(
          (v) => {
            if (!alive) return v.destroy();
            view = v;
            pos.textContent = v.position();
            // Tools from other modules (capturing…), given this item and its stored text.
            let joined: Promise<string> | null = null;
            const part = web ? snap : undefined;
            const text = () => (joined ??= call<StoredJoined | null>("records.text", { id, part }).then((t) => t?.text ?? ""));
            for (const t of shell.slot<ReaderTool>(READER_TOOLS).values()) {
              const d = t.mount(tools, { source: r, view: v, text, part, aside });
              if (typeof d === "function") toolDisposers.push(d);
            }
            if (params.place) {
              try {
                void v.showPlace?.(JSON.parse(params.place));
              } catch {
                /* not a place */
              }
            } else if (params.at) v.goToTextOffset?.(Number(params.at));
          },
          (e) => alive && replace(stage, h("p", { class: "empty" }, `This item couldn’t be opened: ${String(e?.message ?? e)}`)),
        );
      (host as HTMLElement & { focusFind?: () => void }).focusFind = () => {
        findInput.focus();
        findInput.select();
      };
      return () => {
        alive = false;
        toolDisposers.forEach((d) => d());
        view?.destroy();
        host.classList.remove("reader-page");
      };
    },
  });

  shell.actions.add("library", {
    id: "library.find",
    title: "Find in this item",
    keys: ["Mod+F"],
    when: () => shell.router.current().page === "item",
    menu: { name: "edit", group: 2 },
    run: () => (document.querySelector(".reader-page") as (HTMLElement & { focusFind?: () => void }) | null)?.focusFind?.(),
  });

  shell.sidePanel.add("library", "about", {
    id: "about",
    title: "About this item",
    applies: (r) => r.page === "item" && !!r.params.id,
    render(host, route) {
      const r = shell.records.get(route.params.id!);
      if (!r) return;
      const p = (r.fields["provenance"] ?? {}) as Record<string, unknown>;
      const rows: [string, unknown][] = [["Source", p["source"]], ["Author", p["author"]], ["Publication", p["publication"]], ["Published", p["published"]], ["Saved", p["saved-at"]], ["Saved with", p["saved-with"]], ["Original file", p["original-name"]], ["SHA-256", r.fields["sha256"]]];
      replace(host, h("dl", { class: "facts" }, rows.filter(([, v]) => v).map(([k, v]) => [h("dt", null, k), h("dd", null, String(v))])));
    },
  });

  shell.sidebar.add("library", "library", {
    id: "library",
    title: "Library",
    emptyText: "No library items yet.",
    nodes: () => shell.records.list(KIND).sort((a, b) => a.title.localeCompare(b.title)).map((i) => ({ id: i.id, label: i.title || "Untitled", icon: iconFor(i), current: shell.router.current().params.id === i.id, onActivate: () => shell.openRecord(i.id) })),
  }, 1);
}

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
    try {
      new URL(url);
    } catch {
      continue;
    }
    if (!out.includes(url)) out.push(url);
  }
  return out;
}

/** An address as compared for "already saved": no trailing slash, no #fragment (as the backend). */
export function normalizeAddress(u: string): string {
  return (u.split("#")[0] ?? "").replace(/\/+$/, "");
}

/** The addresses saved items came from (as given, and after redirects). */
export function savedAddresses(items: RecordInfo[]): Set<string> {
  const out = new Set<string>();
  for (const i of items) {
    const p = i.fields["provenance"] as { source?: string; "final-url"?: string } | undefined;
    for (const u of [p?.source, p?.["final-url"]]) if (u) out.add(normalizeAddress(u));
  }
  return out;
}
