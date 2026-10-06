/** Library: saved pages, PDFs, images and EPUBs, read in one reader. */
import { call, onFileDrop, pickFiles, readBytes } from "../../backend";
import { h, replace } from "../../kit/dom";
import { icon } from "../../kit/icon";
import { effect, signal } from "../../kit/signal";
import { toast } from "../../kit/toast";
import { count } from "../../kit/format";
import type { ShellApi } from "../../shell/api";
import { ITEM_CHILDREN, READER_TOOLS, type ItemChildren, type ReaderTool } from "../../shell/slots";
import type { StoredText as StoredJoined } from "../../generated/StoredText";
import type { RecordInfo } from "../../generated/RecordInfo";
import type { Written } from "../../generated/Written";
import type { ReaderStore, ReaderView, StoredText } from "../../reader/host";
import { pdfEngine } from "../../reader/pdf";
import { imageEngine } from "../../reader/image";
import { epubEngine } from "../../reader/epub";
import { ask, modal } from "../../kit/dialog";
import { BookOpen, Globe, FileText, Image as ImageIcon, Library as LibraryIcon, Plus, ZoomIn, ZoomOut, Maximize, ChevronUp, ChevronDown, Info } from "lucide";

const KIND = "item";
/** The reader open on each item page shown (for the View menu's layouts). */
const shownReaders = new Map<string, ReaderView>();
const ORIGINAL = "library.original";
const EXTENSIONS = ["pdf", "epub", "png", "jpg", "jpeg", "gif", "webp", "heic", "tif", "tiff"];

/** Where images put into notes are kept: a folder of the Library (decision 0051). */
const ATTACHMENTS = "Attachments";
const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "gif", "webp", "heic", "tif", "tiff"];
/** An item's folder in the Library ("" at the top). */
const folderOfItem = (r: RecordInfo) => {
  const parts = r.path.split("/").slice(1, -2);
  return parts.join("/");
};
const isAttachment = (r: RecordInfo) => r.kind === KIND && (folderOfItem(r) === ATTACHMENTS || folderOfItem(r).startsWith(`${ATTACHMENTS}/`));

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

/** A file's bytes as base64 (for the API). */
async function base64(f: Blob): Promise<string> {
  const bytes = new Uint8Array(await f.arrayBuffer());
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export function library(shell: ShellApi): void {
  // Reading settings and places, per device (settings.json), for engines that keep them.
  const readerStore: ReaderStore = { get: (k) => shell.prefs.get(k), set: (k, v) => shell.prefs.pref<unknown>(k, null).set(v) };
  const manageSnapshots = (r: RecordInfo, showing: string) => manageSnapshotsDialog(shell, r, showing);
  // An attachment made a standalone item: out of Attachments, to the Library's top (notes that show
  // it keep showing it: they point at its ID).
  shell.recordActions.add("library", "promote-attachment", {
    label: (n) => (n === 1 ? "Move to the Library" : `Move ${n} to the Library`),
    applies: (r) => isAttachment(r) && !r.read_only,
    run: async (rs) => {
      const from = new Map(rs.map((r) => [r.id, folderOfItem(r)]));
      try {
        const r = await call<{ moved: Written[]; failed: { id: string; error: string }[] }>("records.move", { ids: rs.map((x) => x.id), folder: null });
        for (const w of r.moved) shell.records.put(w.info, w.seq);
        for (const f of r.failed) toast(f.error);
        if (!r.moved.length) return;
        const what = r.moved.length === 1 ? `“${r.moved[0]!.info.title}”` : count(r.moved.length, "item");
        shell.undo.done(`Moved ${what} to the Library.`, {
          label: `moving ${what}`,
          undo: async () => {
            for (const w of r.moved) {
              const back = await call<{ moved: Written[] }>("records.move", { ids: [w.info.id], folder: from.get(w.info.id) || null });
              for (const b of back.moved) shell.records.put(b.info, b.seq);
            }
          },
          redo: async () => {
            const again = await call<{ moved: Written[] }>("records.move", { ids: r.moved.map((w) => w.info.id), folder: null });
            for (const b of again.moved) shell.records.put(b.info, b.seq);
          },
        });
      } catch (e) {
        toast(String((e as { message?: string }).message ?? e));
      }
    },
  });
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
        let host = "";
        try {
          host = src ? new URL(src).hostname.replace(/^www\./, "") : "";
        } catch {
          /* not an address */
        }
        const n = snapshotsOf(r).length;
        return [host, n > 1 ? count(n, "snapshot") : ""].filter(Boolean).join(" · ");
      }
      const n = Number(r.fields["library.pages"]);
      return n > 0 ? count(n, "page") : "";
    },
  });
  for (const e of [pdfEngine, epubEngine, imageEngine]) shell.readerEngines.add("library", e.id, e);

  /** The library folder being looked at, if any (where new items go). */
  const here = () => {
    const h = shell.here.peek();
    return h?.kind === KIND && h.folder ? h.folder : undefined;
  };
  const importPaths = async (paths: string[]) => {
    if (!paths.length) return;
    shell.status.show(`Adding ${count(paths.length, "file")}…`, 0);
    try {
      // Into the library folder being looked at, if any.
      const folder = here();
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

  // A book's layout, as in Apple Books' View menu (0070); also in the Aa panel.
  const shownBook = () => {
    const r = shell.router.current();
    const item = r.page === "item" ? shell.records.get(r.params.id ?? "") : undefined;
    return item && formatOf(item) === "epub" ? item : undefined;
  };
  for (const [layout, title, n] of [["single", "Single Page", 1], ["two", "Two Pages", 2], ["scroll", "Scrolling", 3]] as const) {
    shell.actions.add("library", {
      id: `library.layout.${layout}`,
      title: `Book layout: ${title}`,
      keys: [`Ctrl+Mod+${n}`],
      when: () => !!shownBook(),
      menu: { name: "view", group: 3, title },
      icon: BookOpen,
      run: () => shownReaders.get(shownBook()?.id ?? "")?.layout?.set(layout),
    });
  }

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
      // New pages go into the library folder being looked at, if any.
      const folder = here();
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
  onFileDrop((paths, at) => {
    // Dropped on a note being written (or a board): added to the library, and shown there.
    const ed = document.elementFromPoint?.(at.x, at.y)?.closest<HTMLElement>(".cm-editor, [data-takes-embeds]");
    if (ed && !ed.closest("[hidden]")) void embedPaths(ed, paths, at);
    else void importPaths(paths);
  }, (over) => dropping.set(over));

  /** Adds files to the library, then asks the editor to show them where they came in. */
  const embedIn = (ed: HTMLElement, written: Written[], at?: { x: number; y: number }) => {
    for (const w of written) shell.records.put(w.info, w.seq);
    if (!written.length) return;
    ed.dispatchEvent(new CustomEvent("librarium:insert-embeds", { detail: { links: written.map((w) => ({ label: w.info.title || "Image", id: w.info.id })), ...at } }));
    const attached = written.filter((w) => isAttachment(w.info)).length;
    shell.status.show(
      attached === written.length
        ? written.length === 1 ? `Attached “${written[0]!.info.title}” (in the Library’s ${ATTACHMENTS}).` : `Attached ${count(written.length, "image")} (in the Library’s ${ATTACHMENTS}).`
        : written.length === 1 ? `Added “${written[0]!.info.title}” to the library.` : `Added ${count(written.length, "item")} to the library.`,
    );
  };
  const embedPaths = async (ed: HTMLElement, paths: string[], at: { x: number; y: number }) => {
    // Images become attachments (the Library's Attachments folder); PDFs and EPUBs go to the top.
    const isImage = (p: string) => IMAGE_EXTENSIONS.includes(p.split(".").pop()!.toLowerCase());
    const imported: Written[] = [];
    try {
      for (const [list, folder] of [[paths.filter(isImage), ATTACHMENTS], [paths.filter((p) => !isImage(p)), null]] as const) {
        if (!list.length) continue;
        const r = await call<ImportResult>("library.import", { paths: list, ...(folder ? { folder } : {}) });
        for (const f of r.failed) toast(f.error);
        imported.push(...r.imported);
      }
      embedIn(ed, imported, at);
    } catch (e) {
      toast(String((e as { message?: string }).message ?? e));
    }
  };
  // Pasted into a note or a board (an image copied in another app): the same, from the data.
  document.addEventListener("librarium:files", (ev) => {
    const ed = (ev.target as HTMLElement).closest<HTMLElement>(".cm-editor, [data-takes-embeds]");
    const files = (ev as CustomEvent<{ files: File[] }>).detail?.files ?? [];
    if (!ed || !files.length) return;
    void (async () => {
      const written: Written[] = [];
      for (const f of files) {
        if (!/^image\/|application\/pdf|epub/.test(f.type)) {
          toast(`“${f.name || "That"}” isn’t an image, a PDF or an EPUB.`);
          continue;
        }
        const ext = (f.type.split("/")[1] ?? "png").replace("jpeg", "jpg").replace("+xml", "");
        const stamp = new Date().toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }).replace(/[/:]/g, ".");
        const name = f.name && f.name !== "image.png" ? f.name : `Pasted image ${stamp}.${ext}`;
        try {
          written.push(await call<Written>("library.importData", { name, data: await base64(f), ...(f.type.startsWith("image/") ? { folder: ATTACHMENTS } : {}) }));
        } catch (e) {
          toast(String((e as { message?: string }).message ?? e));
        }
      }
      embedIn(ed, written);
    })();
  });

  // An item embedded in a note: an image shows itself; anything else shows as a card.
  shell.embeds.add("library", KIND, {
    kind: KIND,
    render(r, open) {
      if (formatOf(r) === "image") {
        // ⌘-click opens it in a new tab, as captures and links do.
        const img = h("img", { class: "embed-image", alt: r.title || "Image", title: r.title, onclick: (e: MouseEvent) => open(r.id, undefined, { newTab: e.metaKey }) }) as HTMLImageElement;
        void readBytes(r.id).then((b) => (img.src = URL.createObjectURL(new Blob([b]))), () => (img.alt = `${r.title} (can’t be shown)`));
        return h("figure", { class: "embed embed-figure" }, img);
      }
      return h("figure", { class: "embed embed-card" }, h("a", { href: "#", class: "list-link", onclick: (e: MouseEvent) => (e.preventDefault(), open(r.id, undefined, { newTab: e.metaKey })) }, icon(iconFor(r), 16), " ", r.title || "Untitled"));
    },
    markdown: (r) => (formatOf(r) === "image" ? `![${r.title}](${r.path.replace(/record\.json$/, String(r.fields[ORIGINAL] ?? ""))})` : `[${r.title}](${r.path})`),
    resizable: (r) => formatOf(r) === "image",
  });
  effect(() => document.body.classList.toggle("dropping", dropping()));

  // Items live in the library's own folders, browsed as in Finder; what an item holds (its
  // captures) shows under it in the sidebar.
  const itemChildren = shell.slot<ItemChildren>(ITEM_CHILDREN);
  shell.folders.add({
    kind: KIND,
    page: "library",
    title: "Library",
    emptyText: "No library items yet. Add PDFs, images or EPUBs (or drop them on the window), or save web pages.",
    children: (r) => itemChildren.values().flatMap((c) => c.children(r)),
    headerActions: () => [
      h("button", { class: "icon-button", "aria-label": "Save web pages", title: "Save web pages", onclick: () => shell.actions.run("library.savePage") }, icon(Globe)),
      h("button", { class: "icon-button", "aria-label": "Add to library", title: "Add to library", onclick: () => shell.actions.run("library.add") }, icon(Plus)),
    ],
  });
  shell.pages.add("library", "library", {
    id: "library",
    title: "Library",
    icon: LibraryIcon,
    ribbon: 2,
    render: (host, params, ctx) => shell.folders.render(KIND, host, params, ctx),
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
      // A place asked for before the document opened.
      let pending: Record<string, string> | null = null;
      const goTo = (v: ReaderView, p: Record<string, string>) => {
        if (p.place) {
          try {
            void v.showPlace?.(JSON.parse(p.place));
          } catch {
            /* not a place */
          }
        } else if (p.at) v.goToTextOffset?.(Number(p.at));
      };
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
        h("span", { class: "zoom-group" }, btn(ZoomOut, "Zoom out", () => view?.zoomOut()), btn(Maximize, "Fit to width", () => view?.zoomReset()), btn(ZoomIn, "Zoom in", () => view?.zoomIn())),
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
        .open(stage, { id, format: web ? "pdf" : formatOf(r), title: r.title, bytes: () => readBytes(id, web ? `snapshots/${snap}/page.pdf` : undefined), text: () => (web ? Promise.resolve(null) : call<StoredText | null>("library.text", { id })), store: readerStore }, {
          moved: () => (pos.textContent = view?.position() ?? ""),
          firstPaint: (ms) => console.info(`reader: first page of ${formatOf(r)} in ${Math.round(ms)} ms`),
        })
        .then(
          (v) => {
            if (!alive) return v.destroy();
            view = v;
            shownReaders.set(id, v);
            pos.textContent = v.position();
            // The reader's own controls, and reading without chrome (Apple Books style).
            if (v.controls?.start) toolbar.prepend(...v.controls.start);
            if (v.controls?.end) findInput.before(...v.controls.end);
            if (v.immersive) toolDisposers.push(immersiveChrome(host, toolbar, findInput, v));
            // Tools from other modules (capturing…), given this item and its stored text.
            let joined: Promise<string> | null = null;
            const part = web ? snap : undefined;
            const text = () => (joined ??= call<StoredJoined | null>("records.text", { id, part }).then((t) => t?.text ?? ""));
            for (const t of shell.slot<ReaderTool>(READER_TOOLS).values()) {
              const d = t.mount(tools, { source: r, view: v, text, part, aside });
              if (typeof d === "function") toolDisposers.push(d);
            }
            goTo(v, pending ?? params);
            pending = null;
          },
          (e) => alive && replace(stage, h("p", { class: "empty" }, `This item couldn’t be opened: ${String(e?.message ?? e)}`)),
        );
      (host as HTMLElement & { focusFind?: () => void }).focusFind = () => {
        findInput.focus();
        findInput.select();
      };
      return {
        dispose() {
          alive = false;
          if (shownReaders.get(id) === view) shownReaders.delete(id);
          toolDisposers.forEach((d) => d());
          view?.destroy();
          host.classList.remove("reader-page");
        },
        // Another place in the same item (Show in the source, a search hit): go there in the open
        // document instead of opening it again. Another snapshot needs a fresh page.
        update(next) {
          if ((next.snapshot ?? "") !== (params.snapshot ?? "")) return false;
          if (view) goTo(view, next);
          else pending = next;
          return true;
        },
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
    icon: Info,
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
    drop: shell.folders.dropOnTop(KIND),
    menu: () => shell.folders.topMenu(KIND),
    nodes: () => shell.folders.tree(KIND),
  }, 1);
}

/** The distinct http(s) addresses in some text (one per line, or anywhere in it). */
/**
 * The toolbar of an immersive reader shows while the pointer is near the top, while something
 * in it has focus or a find is in progress, or while the reader asks (a popover is open).
 */
function immersiveChrome(host: HTMLElement, toolbar: HTMLElement, findInput: HTMLInputElement, v: ReaderView): () => void {
  host.classList.add("reader-immersive");
  let near = false;
  let wanted = false;
  const update = () => host.classList.toggle("show-chrome", near || wanted || toolbar.contains(document.activeElement) || !!findInput.value.trim());
  const at = (y: number) => {
    near = y - host.getBoundingClientRect().top < 64;
    update();
  };
  const move = (e: MouseEvent) => at(e.clientY);
  const leave = () => {
    near = false;
    update();
  };
  host.addEventListener("mousemove", move);
  host.addEventListener("mouseleave", leave);
  toolbar.addEventListener("focusin", update);
  toolbar.addEventListener("focusout", () => setTimeout(update, 0));
  findInput.addEventListener("input", update);
  const stopPointer = v.onPointer?.((p) => at(p.y)) ?? (() => {});
  const stopWanted = v.onChromeWanted?.((w) => {
    wanted = w;
    update();
  }) ?? (() => {});
  return () => {
    stopPointer();
    stopWanted();
    host.removeEventListener("mousemove", move);
    host.removeEventListener("mouseleave", leave);
    host.classList.remove("reader-immersive", "show-chrome");
  };
}

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
