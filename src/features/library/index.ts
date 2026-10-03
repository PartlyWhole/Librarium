/** Library: saved pages, PDFs, images and EPUBs, read in one reader. */
import { call, onFileDrop, pickFiles, readBytes } from "../../backend";
import { h, replace } from "../../kit/dom";
import { icon } from "../../kit/icon";
import { effect, signal, untracked } from "../../kit/signal";
import { toast } from "../../kit/toast";
import { Selection } from "../../kit/selection";
import { selectList, type SelectListElement } from "../../kit/selectlist";
import { selectBar } from "../../shell/selectbar";
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
import { ask, modal } from "../../kit/dialog";
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

type Snapshot = { at: string; checks?: { kind: string; reason: string }[]; "final-url"?: string };
const snapshotsOf = (r: RecordInfo): Snapshot[] => (Array.isArray(r.fields["library.snapshots"]) ? (r.fields["library.snapshots"] as Snapshot[]) : []);

interface RemovalPreview {
  token: string;
  count: number;
  items: { id: string; title: string; remove: string[]; protected: { at: string; by: string[] }[]; kept: number }[];
}

/**
 * Removes snapshots of saved pages, in two steps: the backend lists what would go (never the
 * last one, never one a capture was made from) with a single-use token, and only the user's
 * explicit confirmation sends it back. Cancel is the default button.
 */
export async function removeSnapshots(shell: ShellApi, items: { id: string; snapshots?: string[] }[]): Promise<boolean> {
  let p: RemovalPreview;
  try {
    p = await call<RemovalPreview>("library.removeSnapshots.prepare", { items });
  } catch (e) {
    toast(String((e as { message?: string }).message ?? e));
    return false;
  }
  const pages = p.items.filter((i) => i.remove.length);
  const protectedN = p.items.reduce((n, i) => n + i.protected.length, 0);
  const keptNote = protectedN ? h("p", { class: "muted small" }, `${count(protectedN, "snapshot")} ${protectedN === 1 ? "is" : "are"} kept because captures were made from ${protectedN === 1 ? "it" : "them"}.`) : null;
  if (!p.count) {
    await ask("Nothing to remove", h("div", null, h("p", null, "Each page keeps at least one snapshot."), keptNote), [{ label: "OK", value: true, primary: true }]);
    return false;
  }
  const title = pages.length === 1 ? `Remove ${count(p.count, "snapshot")} of “${pages[0]!.title || "Untitled"}”?` : `Remove ${count(p.count, "snapshot")} from ${count(pages.length, "page")}?`;
  const ok = await ask(
    title,
    h("div", null,
      h("p", null, "Their PDFs and text are deleted from the library folder. It can’t be undone. Each page keeps at least one snapshot."),
      keptNote,
      pages.length > 1 ? h("ul", { class: "delete-list" }, pages.map((i) => h("li", null, `${i.title || "Untitled"} (${i.remove.length})`))) : null,
    ),
    [
      { label: "Cancel", value: false },
      { label: p.count === 1 ? "Remove snapshot" : "Remove snapshots", value: true, destructive: true },
    ],
  );
  if (!ok) return false;
  try {
    const r = await call<{ removed: number; skipped: { id: string; reason: string }[] }>("library.removeSnapshots", { token: p.token });
    shell.status.show(`Removed ${count(r.removed, "snapshot")}.`);
    for (const s of r.skipped) toast(`Not removed from ${shell.records.get(s.id)?.title || "a page"}: ${s.reason}.`);
    return true;
  } catch (e) {
    toast(String((e as { message?: string }).message ?? e));
    return false;
  }
}

export function library(shell: ShellApi): void {
  const manageSnapshots = (r: RecordInfo, showing: string) => manageSnapshotsDialog(shell, r, showing);
  shell.recordActions.add("library", "remove-older-snapshots", {
    label: (n) => (n === 1 ? "Remove older snapshots…" : `Remove older snapshots of ${n} pages…`),
    applies: (r) => r.kind === KIND && snapshotsOf(r).length > 1 && !r.read_only,
    destructive: true,
    partial: true,
    run: (rs) => void removeSnapshots(shell, rs.map((r) => ({ id: r.id }))),
  });
  shell.openers.add("library", KIND, "item");
  shell.looks.add("library", KIND, {
    kind: KIND,
    icon: iconFor,
    kindName: (r) => ({ web: "Web page", pdf: "PDF", epub: "EPUB", image: "Image" })[formatOf(r)] ?? "Item",
    detail: (r) => {
      if (formatOf(r) === "web") {
        const src = (r.fields.provenance as { source?: string } | undefined)?.source;
        try {
          return src ? new URL(src).hostname.replace(/^www\./, "") : "";
        } catch {
          return "";
        }
      }
      const n = Number(r.fields["library.pages"]);
      return n > 0 ? count(n, "page") : "";
    },
  });
  for (const e of [pdfEngine, epubEngine, imageEngine]) shell.readerEngines.add("library", e.id, e);

  const importPaths = async (paths: string[]) => {
    if (!paths.length) return;
    shell.status.show(`Adding ${count(paths.length, "file")}…`, 0);
    try {
      // Into the folder being looked at, if any.
      const folder = shell.here.peek() || undefined;
      const r = await call<ImportResult>("library.import", { paths, folder });
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
      // New pages go into the folder being looked at, if any.
      const folder = shell.here.peek() || undefined;
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
            await call("library.savePage", { url, hide: shell.hidingFields.values(), folder });
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
      const m = modal(h("div", { class: "ask" }, h("h2", { class: "ask-title" }, "Save web pages"), h("p", { class: "muted small" }, "Librarium keeps a faithful PDF of each page and its clean text, with where and when it came from. Pages are saved one after another in the background.", folder ? ` New pages go into “${folder.split("/").pop()}”.` : ""), input, count, againRow, h("div", { class: "ask-buttons" }, h("button", { class: "button", onclick: () => m.close() }, "Cancel"), h("button", { class: "button primary", title: "Save (⌘↩)", onclick: () => void go() }, "Save"))), { label: "Save web pages" });
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
      // The selection and select mode outlive re-renders (a record changing re-renders the list).
      const selection = new Selection();
      const mode = signal(false);
      let list: SelectListElement | null = null;
      const items = () => shell.records.list(KIND).sort((a, b) => a.title.localeCompare(b.title));
      const bar = selectBar(shell, { selection, mode, items, sync: () => list?.sync(), noun: ["item", "items"] });
      const detail = (i: RecordInfo) => {
        const snaps = Array.isArray(i.fields["library.snapshots"]) ? (i.fields["library.snapshots"] as unknown[]).length : 0;
        if (snaps > 1) return count(snaps, "snapshot");
        return i.fields["library.pages"] ? count(Number(i.fields["library.pages"]), formatOf(i) === "epub" ? "chapter" : "page") : "";
      };
      const stop = effect(() => {
        const all = items();
        untracked(() => {
          list = all.length
            ? selectList({
                label: "Library items",
                className: "item-list",
                items: all,
                selection,
                mode,
                id: (i) => i.id,
                render: (i) => h("span", { class: "item-link" }, icon(iconFor(i), 16), h("span", null, i.title || "Untitled"), h("span", { class: "muted small" }, detail(i))),
                open: (i) => shell.openRecord(i.id),
                menu: (rs, at) => shell.showRecordMenu(rs, at),
              })
            : null;
          replace(
            host,
            h("h1", { class: "page-title" }, "Library"),
            all.length ? h("p", { class: "muted small list-hint" }, `${count(all.length, "item")}. To act on several, choose Select (or press ⌘A); right-click for what you can do.`) : null,
            all.length ? bar.el : null,
            list ?? h("p", { class: "empty" }, "No library items yet. Add PDFs, images or EPUBs, or drop them on the window."),
          );
        });
      });
      return () => {
        stop();
        bar.dispose();
      };
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
          const manage = h("button", { class: "link-button small", type: "button", onclick: () => void manageSnapshots(r, snap) }, "Snapshots…");
          tools.before(pick, manage);
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

/** "Snapshots…": tick the snapshots of a page to remove. */
async function manageSnapshotsDialog(shell: ShellApi, r: RecordInfo, showing: string): Promise<void> {
  const snaps = snapshotsOf(r);
  const latest = snaps[snaps.length - 1]?.at;
  const boxes = snaps.map((s) => h("input", { type: "checkbox", value: s.at, "aria-label": snapshotLabel(s.at) }) as HTMLInputElement);
  const rows = snaps.map((s, i) =>
    h("label", { class: "check-row snapshot-row" }, boxes[i]!, h("span", null, snapshotLabel(s.at)),
      h("span", { class: "muted small" }, [s.at === latest ? "latest" : "", s.at === showing ? "showing" : "", ...(s.checks ?? []).map((c) => c.kind)].filter(Boolean).join(" · "))),
  );
  const chosen = await ask<string[]>(
    `Snapshots of “${r.title || "Untitled"}”`,
    h("div", null, h("p", { class: "muted small" }, "Tick the snapshots to remove. A page keeps at least one, and snapshots that captures were made from stay."), h("div", { class: "snapshot-list" }, rows)),
    [
      { label: "Cancel", value: [] },
      { label: "Remove ticked…", value: ["__ticked__"], destructive: true },
    ],
  );
  if (!chosen?.length) return;
  const ticked = boxes.filter((b) => b.checked).map((b) => b.value);
  if (!ticked.length) return toast("Nothing was ticked.");
  if (await removeSnapshots(shell, [{ id: r.id, snapshots: ticked }])) {
    // Show what remains (the snapshot being shown may be gone).
    if (ticked.includes(showing)) shell.router.go("item", { id: r.id }, { replace: true });
  }
}
