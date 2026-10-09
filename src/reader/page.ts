/**
 * The item page: one reader for every format (a saved web page reads as its snapshot's PDF),
 * under a toolbar with zoom, the position, tools, and find. Params: `id`, `snapshot`, and a
 * place to go to: `place` (W3C selectors, as JSON) or `at` (a code-point offset, from search).
 */
import { call, readBytes } from "../backend";
import type { PageContext, PageHandle } from "../app/pages";
import { formatOf, getRecord } from "../app/records";
import { errorText, h, replace } from "../ui/dom";
import { iconButton } from "../ui/icon";
import { untracked } from "../ui/signal";
import type { StoredText } from "../types";
import { announce } from "./session";
import { snapshotControls, snapshotNotices } from "./snapshots";
import type { Engine, Extracted, ReaderView } from "./types";
import { ChevronDown, ChevronUp, Maximize, ZoomIn, ZoomOut } from "lucide";

/** Engines load the first time their format is opened, not with the app. */
const ENGINES: Record<string, () => Promise<Engine>> = {
  pdf: () => import("./pdf/pdf").then((m) => m.openPdf),
  image: () => import("./image/image").then((m) => m.openImage),
  epub: () => import("./epub/engine").then((m) => m.openEpub),
};

/** The find field of the item page shown (⌘F focuses it). */
export function focusFind(): void {
  const input = document.querySelector<HTMLInputElement>(".reader-page:not([hidden]) .find-input");
  input?.focus();
  input?.select();
}

export function renderItem(host: HTMLElement, params: Record<string, string>, ctx: PageContext): PageHandle {
  const id = params.id ?? "";
  const r = untracked(() => getRecord(id));
  if (!r) return replace(host, h("p", { class: "empty" }, "This item can’t be found any more."));
  ctx.setTitle(r.title || "Untitled");
  host.classList.add("reader-page");
  const web = formatOf(r) === "web";
  const snap = web ? params.snapshot || String(r.fields["library.snapshot"] ?? "") : undefined;
  const load = ENGINES[web ? "pdf" : formatOf(r)];

  const stage = h("div", { class: "reader-stage" });
  const body = h("div", { class: "reader-body" }, stage);
  const pos = h("span", { class: "reader-pos muted small", "aria-live": "polite" });
  const findInput = h("input", { class: "find-input", type: "search", placeholder: "Find", "aria-label": "Find in this item", spellcheck: false });
  const findCount = h("span", { class: "muted small find-count", "aria-live": "polite" });
  const tools = h("span", { class: "reader-tools" });
  let view: ReaderView | null = null;
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
      e.preventDefault();
      findInput.value = "";
      void find();
    }
  });
  findInput.addEventListener("input", () => void find());
  const toolbar = h("div", { class: "reader-toolbar", role: "toolbar", "aria-label": "Reader" },
    h("span", { class: "zoom-group" }, iconButton(ZoomOut, "Zoom out", () => view?.zoomOut()), iconButton(Maximize, "Fit width", () => view?.zoomReset()), iconButton(ZoomIn, "Zoom in", () => view?.zoomIn())),
    pos, web ? snapshotControls(r, snap!) : null, tools, h("span", { class: "spacer" }),
    findInput, findCount, iconButton(ChevronUp, "Previous match", () => void find(true, true), "Shift+Enter"), iconButton(ChevronDown, "Next match", () => void find(true), "Enter"));
  replace(host, toolbar, web ? h("div", { class: "reader-notices" }, snapshotNotices(r, snap!)) : null, body);
  if (!load) {
    replace(stage, h("p", { class: "empty" }, "This kind of item can’t be shown here yet."));
    return () => host.classList.remove("reader-page");
  }

  let alive = true;
  const cleanup: (() => void)[] = [];
  // The stored text anchors and search offsets point into, fetched once.
  let stored: Promise<StoredText | null> | null = null;
  const storedText = () => (stored ??= call<StoredText | null>("records.text", { id, part: snap ?? null }).catch(() => null));
  // A place asked for before the document opened.
  let pending: Record<string, string> | null = params;
  const goTo = (v: ReaderView, p: Record<string, string>) => {
    if (p.place) {
      try {
        void v.showPlace?.(JSON.parse(p.place));
      } catch {
        /* not a place */
      }
    } else if (p.at && web) {
      // A saved page's text isn't split into the PDF's pages: its first words there are found.
      void storedText().then((t) => {
        const words = t ? [...t.text].slice(Number(p.at), Number(p.at) + 400).join("").trim().split(/\s+/).slice(0, 8).join(" ") : "";
        if (!words || !alive) return;
        findInput.value = words;
        void find(true);
      });
    } else if (p.at) v.goToTextOffset?.(Number(p.at));
  };
  const src = {
    id,
    title: r.title,
    bytes: () => readBytes(id, web ? `snapshots/${snap}/page.pdf` : undefined),
    text: () => (web ? Promise.resolve(null) : call<Extracted | null>("library.text", { id }).catch(() => null)),
  };
  void load()
    .then((engine) => engine(stage, src, {
      moved: () => (pos.textContent = view?.position() ?? ""),
      firstPaint: (ms) => void call("app.log", { level: "info", message: `reader: first page of ${formatOf(r)} in ${Math.round(ms)} ms` }).catch(() => {}),
    }))
    .then((v) => {
      if (!alive) return v.destroy();
      view = v;
      pos.textContent = v.position();
      if (v.controls?.start) toolbar.prepend(...v.controls.start);
      if (v.controls?.end) findInput.before(...v.controls.end);
      if (v.immersive) cleanup.push(immersiveChrome(host, toolbar, findInput, v));
      cleanup.push(announce({ source: r, snapshot: snap, view: v, tools, body, text: storedText }));
      if (pending) goTo(v, pending);
      pending = null;
    }, (e) => alive && replace(stage, h("p", { class: "empty" }, `This item couldn’t be opened: ${errorText(e)}`)));

  return {
    dispose() {
      alive = false;
      cleanup.forEach((d) => d());
      view?.destroy();
      host.classList.remove("reader-page");
    },
    // Another place in the same item (Show, a search hit) is gone to in the open document;
    // another snapshot needs the page afresh.
    update(next) {
      if ((next.snapshot ?? "") !== (params.snapshot ?? "")) return false;
      if (view) goTo(view, next);
      else pending = next;
      return true;
    },
  };
}

/**
 * An immersive reader's toolbar shows while the pointer is near the top, while something in it
 * has focus or a find is in progress, or while the engine asks (a popover is open).
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
  const leave = () => ((near = false), update());
  const blur = () => setTimeout(update, 0);
  host.addEventListener("mousemove", move);
  host.addEventListener("mouseleave", leave);
  toolbar.addEventListener("focusin", update);
  toolbar.addEventListener("focusout", blur);
  findInput.addEventListener("input", update);
  const stopPointer = v.onPointer?.((p) => at(p.y));
  const stopWanted = v.onChromeWanted?.((w) => ((wanted = w), update()));
  return () => {
    stopPointer?.();
    stopWanted?.();
    host.removeEventListener("mousemove", move);
    host.removeEventListener("mouseleave", leave);
    toolbar.removeEventListener("focusin", update);
    toolbar.removeEventListener("focusout", blur);
    host.classList.remove("reader-immersive", "show-chrome");
  };
}
