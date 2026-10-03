/** Library: saved pages, PDFs, images and EPUBs, read in one reader. */
import { call, onFileDrop, pickFiles, readBytes } from "../../backend";
import { h, replace } from "../../kit/dom";
import { icon } from "../../kit/icon";
import { effect, signal } from "../../kit/signal";
import { toast } from "../../kit/toast";
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
import { BookOpen, FileText, Image as ImageIcon, Library as LibraryIcon, Plus, ZoomIn, ZoomOut, Maximize, ChevronUp, ChevronDown } from "lucide";

const KIND = "item";
const EXTENSIONS = ["pdf", "epub", "png", "jpg", "jpeg", "gif", "webp", "heic", "tif", "tiff"];

function formatOf(r: RecordInfo): string {
  return String(r.fields["library.format"] ?? "");
}

function iconFor(r: RecordInfo) {
  const f = formatOf(r);
  return f === "image" ? ImageIcon : f === "epub" ? BookOpen : FileText;
}

interface ImportResult {
  imported: Written[];
  failed: { path: string; error: string }[];
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
            ? h("ul", { class: "item-list" }, items.map((i) => h("li", null, h("a", { href: "#", class: "item-link", onclick: (e: Event) => (e.preventDefault(), shell.openRecord(i.id)) }, icon(iconFor(i), 16), h("span", null, i.title || "Untitled"), h("span", { class: "muted small" }, i.fields["library.pages"] ? count(Number(i.fields["library.pages"]), formatOf(i) === "epub" ? "chapter" : "page") : "")))))
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
      const engine = shell.readerEngines.values().find((e) => e.formats.includes(formatOf(r)));
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
      replace(host, toolbar, stage);
      if (!engine) {
        replace(stage, h("p", { class: "empty" }, "This kind of item can’t be shown here yet."));
        return;
      }
      void engine
        .open(stage, { id, format: formatOf(r), title: r.title, bytes: () => readBytes(id), text: () => call<StoredText | null>("library.text", { id }) }, {
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
            const text = () => (joined ??= call<StoredJoined | null>("records.text", { id }).then((t) => t?.text ?? ""));
            for (const t of shell.slot<ReaderTool>(READER_TOOLS).values()) {
              const d = t.mount(tools, { source: r, view: v, text });
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
