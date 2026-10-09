/**
 * PDFs (and saved web pages' snapshots): PDF.js through its viewer components, with its worker,
 * wasm decoders (JBIG2, JPEG 2000), cmaps and standard fonts served locally. Without `wasmUrl`,
 * JBIG2 and JPEG 2000 scans silently fail to render.
 */
import "./polyfills";
// The legacy build: the modern one needs JavaScript that macOS 15's WebKit doesn't have yet.
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { EventBus, PDFFindController, PDFLinkService, PDFViewer } from "pdfjs-dist/legacy/web/pdf_viewer.mjs";
import "pdfjs-dist/legacy/web/pdf_viewer.css";
import { h } from "../../ui/dom";
import { caretIn, rangeEditor, rangeFromBoxes, regionEditor } from "../handles";
import { boxesIn, dragRect, drawMarks, endOf, flashPlace, innerRect, outlineRegion, regionOn, snapToWords, watchMarkClicks } from "../marks";
import { ocrFind, ocrLayer, type OcrLine } from "../ocr";
import { boxesPlace, pageAtOffset, pageOf, regionOf, type Box, type EditPart, type Engine, type Mark, type ReaderView } from "../types";
import { alignToInk, invisibleText } from "./ink";
import { knownWords, placeWords } from "./words";

const BASE = "/pdfjs/";
pdfjs.GlobalWorkerOptions.workerSrc = `${BASE}pdf.worker.min.mjs`;

/** Local assets only, no scripting, no eval; fonts' widths kept to place the text (words.ts). */
const DOCUMENT_OPTIONS = {
  cMapUrl: `${BASE}cmaps/`,
  cMapPacked: true,
  standardFontDataUrl: `${BASE}standard_fonts/`,
  wasmUrl: `${BASE}wasm/`,
  iccUrl: `${BASE}iccs/`,
  isEvalSupported: false,
  enableXfa: false,
  fontExtraProperties: true,
};

type PageView = { div?: HTMLElement; pdfPage?: pdfjs.PDFPageProxy; setPdfPage(p: pdfjs.PDFPageProxy): void };

export const openPdf: Engine = async (host, src, events) => {
  const t0 = performance.now();
  const viewerEl = h("div", { class: "pdfViewer" });
  const container = h("div", { class: "pdf-container", tabindex: "0", "aria-label": `${src.title}, document` }, viewerEl);
  host.appendChild(container);
  const eventBus = new EventBus();
  const linkService = new PDFLinkService({ eventBus });
  const findController = new PDFFindController({ eventBus, linkService });
  // No page borders: the text layer is sized to the page box, so a border would make it larger
  // than the drawn page and selections would drift off the words.
  const viewer = new PDFViewer({ container, viewer: viewerEl, eventBus, linkService, findController, removePageBorders: true, textLayerMode: 1, annotationMode: pdfjs.AnnotationMode.ENABLE });
  linkService.setViewer(viewer);
  const pageView = (n: number) => viewer.getPageView(n - 1) as PageView | undefined;
  const pageDiv = (n: number) => pageView(n)?.div;

  // A place being shown, redrawn if its page renders again (PDF.js clears unknown children).
  let marked: { page: number; region: { x: number; y: number; w: number; h: number }; boxes?: Box[] } | null = null;
  // While a capture's parts are edited, places are shown without outlines (the parts are drawn).
  let editingParts = false;
  const clearPlace = () => {
    marked = null;
    container.querySelectorAll(".region-mark, .place-mark").forEach((n) => n.remove());
  };
  const drawPlace = (scroll: boolean) => {
    const div = marked && pageDiv(marked.page);
    if (!marked || !div) return;
    if (!marked.boxes) {
      const m = outlineRegion(div, marked.region);
      if (scroll) m.scrollIntoView({ block: "center" });
      return;
    }
    flashPlace(div, marked.boxes, marked.page);
    if (scroll) {
      // The passage's middle to the middle of the view.
      const b = innerRect(div);
      const mid = b.top + ((marked.region.y + marked.region.h / 2) / 100) * b.height;
      const c = container.getBoundingClientRect();
      container.scrollTop += mid - (c.top + c.height / 2);
    }
    const shown = marked;
    setTimeout(() => marked === shown && (marked = null), 2500);
  };

  // Recognised text of scanned pages, laid over them so it can be selected and found.
  const recognized = new Map<number, OcrLine[]>();
  const text = src.text();
  void text.then((t) => {
    for (const p of t?.pages ?? []) if (p.lines?.length) recognized.set(p.page, p.lines);
  });

  let marks: Mark[] = [];
  const drawPageMarks = (n: number) => {
    const div = pageDiv(n);
    if (div) drawMarks(div, marks, n);
  };
  // Scanned pages (text drawn invisibly over a picture): the words are moved onto the ink,
  // after the page and its text are drawn, and again after a zoom.
  const inkTimers = new Map<number, ReturnType<typeof setTimeout>>();
  const onInk = (n: number) => {
    clearTimeout(inkTimers.get(n));
    inkTimers.set(n, setTimeout(() => {
      const pv = pageView(n);
      if (!pv?.div || !pv.pdfPage) return;
      void invisibleText(pv.pdfPage).then((yes) => yes && pv.div!.querySelector(".textLayer span") && alignToInk(pv.div!));
    }, 30));
  };
  let painted = false;
  eventBus.on("textlayerrendered", (e: { pageNumber: number }) => onInk(e.pageNumber));
  eventBus.on("pagerendered", (e: { pageNumber: number }) => {
    const n = e.pageNumber;
    onInk(n);
    if (marked?.page === n) drawPlace(false);
    drawPageMarks(n);
    const lines = recognized.get(n);
    const div = pageDiv(n);
    if (lines && div) ocrLayer(div, lines);
    if (!painted && n === viewer.currentPageNumber) {
      painted = true;
      events.firstPaint(performance.now() - t0);
    }
  });
  eventBus.on("pagechanging", () => events.moved());

  // Fit to the width, and keep fitting as the reader's width changes, until the user zooms.
  // Pages exist only after "pagesinit": anything that moves to a page waits for it.
  let fit = true;
  let inited = false;
  const refit = () => {
    if (fit && inited && container.clientWidth > 40) viewer.currentScaleValue = "page-width";
  };
  const pagesReady = new Promise<void>((resolve) =>
    eventBus.on("pagesinit", () => {
      inited = true;
      refit();
      resolve();
    }),
  );
  const resized = new ResizeObserver(refit);
  resized.observe(container);

  const task = pdfjs.getDocument({ data: new Uint8Array(await src.bytes()), ...DOCUMENT_OPTIONS });
  const doc = await task.promise;
  // Every page's text mended against the stored text's words and placed on the printed words,
  // before anything reads it.
  const known = src.storedText().then(knownWords, () => knownWords(null));
  const getPage = doc.getPage.bind(doc);
  doc.getPage = (n) => getPage(n).then((p) => (placeWords(p, known), p));
  viewer.setDocument(doc);
  linkService.setDocument(doc);

  // Until PDF.js has loaded a page it is laid out at the first page's size; where pages differ
  // (a JSTOR cover page), a place scrolled to would move as real sizes arrive. So the pages up
  // to a place are measured before going there.
  const sizedTo = async (n: number) => {
    for (let i = 1; i <= n; i++) {
      const pv = pageView(i);
      if (pv && !pv.pdfPage) pv.setPdfPage(await doc.getPage(i));
    }
  };

  // Find: PDF.js searches pages in the background, reporting its state and the count.
  let lastFind = { count: 0, current: 0 };
  let settled = false;
  const waiters: (() => void)[] = [];
  const wake = () => waiters.splice(0).forEach((w) => w());
  type Count = { matchesCount?: { current: number; total: number } };
  eventBus.on("updatefindmatchescount", (e: Count) => {
    if (e.matchesCount) lastFind = { count: e.matchesCount.total, current: e.matchesCount.current };
    wake();
  });
  eventBus.on("updatefindcontrolstate", (e: Count & { state: number }) => {
    if (e.matchesCount) lastFind = { count: e.matchesCount.total, current: e.matchesCount.current };
    settled = e.state !== 3; // 3: still searching
    wake();
  });
  const find = async (query: string, opts: { again?: boolean; back?: boolean } = {}) => {
    settled = false;
    eventBus.dispatch("find", { source: view, type: opts.again ? "again" : "", query, caseSensitive: false, entireWord: false, highlightAll: true, findPrevious: !!opts.back, matchDiacritics: false });
    // Until the search settles with a count, or for 3 s at most.
    const deadline = performance.now() + 3000;
    while ((!settled || (lastFind.count === 0 && performance.now() < deadline - 2000)) && performance.now() < deadline) {
      await new Promise<void>((r) => {
        waiters.push(r);
        setTimeout(r, 100);
      });
    }
    // Scanned pages without text of their own: their recognised text.
    if (lastFind.count === 0 && recognized.size) {
      const q = query.toLowerCase();
      const page = [...recognized.entries()].find(([, ls]) => ls.some((l) => l.text.toLowerCase().includes(q)))?.[0];
      if (page) {
        viewer.currentPageNumber = page;
        await new Promise((r) => setTimeout(r, 200));
        const hits = ocrFind(container, query);
        hits[0]?.scrollIntoView({ block: "center" });
        return { count: Math.max(1, hits.length), current: 1 };
      }
    }
    return lastFind;
  };

  // A range's text, with its page and its line boxes on every page it crosses.
  const selOf = (range: Range) => {
    const startEl = range.startContainer instanceof Element ? range.startContainer : range.startContainer.parentElement;
    const pageEl = startEl?.closest<HTMLElement>(".page");
    const boxes: Box[] = [];
    for (const p of container.querySelectorAll<HTMLElement>(".page")) {
      if (range.intersectsNode(p)) boxes.push(...boxesIn(range, p, Number(p.dataset.pageNumber)));
    }
    // The text layer's line ends are <br>s, which a range's text leaves out: they count.
    const frag = range.cloneContents();
    frag.querySelectorAll("br").forEach((b) => b.replaceWith("\n"));
    const text = (frag.textContent ?? "").replace(/[ \t]+\n/g, "\n").trim();
    return { text, page: pageEl ? Number(pageEl.dataset.pageNumber) : viewer.currentPageNumber, boxes, end: endOf(range) };
  };

  const view: ReaderView = {
    zoomIn: () => ((fit = false), (viewer.currentScale = Math.min(8, viewer.currentScale * 1.2))),
    zoomOut: () => ((fit = false), (viewer.currentScale = Math.max(0.25, viewer.currentScale / 1.2))),
    zoomReset: () => ((fit = true), refit()),
    find,
    findClear: () => {
      eventBus.dispatch("findbarclose", { source: view });
      ocrFind(container, "");
    },
    goToTextOffset(offset) {
      void Promise.all([text, pagesReady]).then(async ([t]) => {
        if (!t?.pages?.length) return;
        const n = pageAtOffset(t.pages, offset) + 1;
        await sizedTo(n);
        viewer.currentPageNumber = n;
      });
    },
    position: () => (doc.numPages ? `Page ${viewer.currentPageNumber} of ${doc.numPages}` : ""),
    selection() {
      const sel = window.getSelection();
      if (!sel?.rangeCount || !sel.toString().trim() || !container.contains(sel.anchorNode)) return null;
      return selOf(sel.getRangeAt(0));
    },
    watchSelection(cb) {
      // When a drag or a keyboard selection ends (not at every step of it).
      const up = () => setTimeout(() => (snapToWords(window.getSelection()), cb()), 0);
      const key = (e: KeyboardEvent) => e.shiftKey && setTimeout(cb, 0);
      const change = () => !window.getSelection()?.toString().trim() && cb();
      container.addEventListener("mouseup", up);
      container.addEventListener("keyup", key);
      document.addEventListener("selectionchange", change);
      return () => {
        container.removeEventListener("mouseup", up);
        container.removeEventListener("keyup", key);
        document.removeEventListener("selectionchange", change);
      };
    },
    clearSelection: () => window.getSelection()?.removeAllRanges(),
    onMarkClick: (cb) => watchMarkClicks(container, cb),
    setMarks(m) {
      marks = m;
      for (let n = 1; n <= doc.numPages; n++) if (pageDiv(n)?.isConnected) drawPageMarks(n);
    },
    async pickRegion() {
      const r = await dragRect(container);
      if (!r) return null;
      // The page under the region's centre.
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const pageEl = [...container.querySelectorAll<HTMLElement>(".page")].find((p) => {
        const b = p.getBoundingClientRect();
        return cx >= b.left && cx <= b.right && cy >= b.top && cy <= b.bottom;
      });
      const box = pageEl && regionOn(pageEl, r);
      if (!pageEl || !box) return null;
      const n = Number(pageEl.dataset.pageNumber);
      const { x, y, w, h: hh } = box;
      return { page: n, x, y, w, h: hh, png: await renderRegion(doc, n, box) };
    },
    async showPlace(selectors) {
      await pagesReady;
      const drawn = boxesPlace(selectors);
      await sizedTo(Math.min(doc.numPages, Math.max(drawn?.page ?? 0, pageOf(selectors) ?? 0)));
      // Where it was drawn: straight there (a text search could miss, or find another).
      if (drawn?.page && drawn.page >= 1 && drawn.page <= doc.numPages) {
        viewer.currentPageNumber = drawn.page;
        marked = { page: drawn.page, region: drawn.region, boxes: selectors.find((x) => x.type === "librarium:boxes")?.boxes };
        drawPlace(true);
        if (editingParts) clearPlace();
        return true;
      }
      const page = pageOf(selectors);
      if (!page || page < 1 || page > doc.numPages) return false;
      viewer.currentPageNumber = page;
      const region = regionOf(selectors);
      if (region) {
        marked = { page, region };
        drawPlace(true);
        if (editingParts) clearPlace();
        return true;
      }
      marked = null;
      const quote = selectors.find((s) => s.type === "TextQuoteSelector")?.exact;
      if (quote) await find(quote.replace(/\s+/g, " ").slice(0, 200));
      return true;
    },
    editParts(parts, onChange) {
      editingParts = true;
      clearPlace();
      const stop = editPdfParts(parts, onChange);
      return { update: stop.update, stop: () => ((editingParts = false), clearPlace(), stop.stop()) };
    },
    destroy() {
      resized.disconnect();
      viewer.cleanup();
      void task.destroy();
      container.remove();
    },
  };

  /** Handles on the parts' text, frames on their regions, found again as pages render. */
  function editPdfParts(parts: EditPart[], onChange: Parameters<NonNullable<ReaderView["editParts"]>>[1]) {
    let current = parts.map((p) => ({ ...p }));
    let editors: { destroy(): void }[] = [];
    let dragging = false;
    const layerAt = (x: number, y: number) =>
      [...container.querySelectorAll<HTMLElement>(".page")].find((p) => {
        const b = p.getBoundingClientRect();
        return y >= b.top && y <= b.bottom && x >= b.left - 40 && x <= b.right + 40;
      })?.querySelector<HTMLElement>(".textLayer") ?? null;
    const rangeOf = (p: EditPart) =>
      rangeFromBoxes(p.boxes ?? [], (b, right) => {
        const d = pageDiv(b.page ?? p.page ?? 1);
        const layer = d?.querySelector<HTMLElement>(".textLayer");
        if (!d || !layer) return null;
        const r = innerRect(d);
        return caretIn(document, layer, r.left + (r.width * (right ? b.x + b.w - 0.3 : b.x + 0.3)) / 100, r.top + (r.height * (b.y + b.h / 2)) / 100);
      });
    const build = () => {
      editors.forEach((e) => e.destroy());
      editors = [];
      for (const p of current) {
        if (p.region) {
          const n = p.region.page ?? 1;
          const d = pageDiv(n);
          if (!d) continue;
          editors.push(regionEditor({
            over: d,
            region: p.region,
            onDrag: (r) => ((dragging = true), onChange({ key: p.key, done: false, region: { page: n, ...r } })),
            onDone: async (r) => {
              dragging = false;
              p.region = { page: n, ...r };
              onChange({ key: p.key, done: true, region: { page: n, ...r, png: await renderRegion(doc, n, r) } });
            },
          }));
          continue;
        }
        const range = rangeOf(p);
        if (!range) continue;
        editors.push(rangeEditor({
          overlay: container,
          range,
          screenRects: (r) => [...r.getClientRects()],
          caretAt: (x, y) => {
            const layer = layerAt(x, y);
            return layer ? caretIn(document, layer, x, y) : null;
          },
          onDrag: (r) => ((dragging = true), onChange({ key: p.key, done: false, text: selOf(r) })),
          onDone: (r) => {
            dragging = false;
            const t = selOf(r);
            p.boxes = t.boxes;
            onChange({ key: p.key, done: true, text: t });
          },
          // Dragged to the top or bottom, the document scrolls.
          edges: { bounds: () => container.getBoundingClientRect(), margin: 28, delay: 0, repeat: 30, nudge: (_dx, dy) => void (container.scrollTop += dy * 20) },
        }));
      }
    };
    // Pages render as they come into view (and again on zoom): the parts are found again.
    const rendered = () => !dragging && build();
    eventBus.on("textlayerrendered", rendered);
    build();
    return {
      update(next: EditPart[]) {
        current = next.map((p) => ({ ...p }));
        build();
      },
      stop() {
        eventBus.off("textlayerrendered", rendered);
        editors.forEach((e) => e.destroy());
        editors = [];
      },
    };
  }

  return view;
};

/**
 * Renders a region of a page (percent) afresh, sharp: about 2,000 px across at most, and never
 * below twice the page's natural size.
 */
async function renderRegion(doc: pdfjs.PDFDocumentProxy, n: number, r: { x: number; y: number; w: number; h: number }): Promise<string> {
  const page = await doc.getPage(n);
  const base = page.getViewport({ scale: 1 });
  const scale = Math.max(2, Math.min(6, 2000 / Math.max(1, (base.width * r.w) / 100)));
  const vp = page.getViewport({ scale });
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round((vp.width * r.w) / 100));
  c.height = Math.max(1, Math.round((vp.height * r.h) / 100));
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, c.width, c.height);
  await page.render({ canvas: c, canvasContext: ctx, viewport: vp, transform: [1, 0, 0, 1, -(vp.width * r.x) / 100, -(vp.height * r.y) / 100], background: "#fff" }).promise;
  return c.toDataURL("image/png");
}
