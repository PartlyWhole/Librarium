/**
 * The PDF engine: PDF.js through its viewer components, with its worker, wasm decoders
 * (JBIG2, JPEG 2000), cmaps and standard fonts served locally and `wasmUrl` set — without
 * the wasm files, JBIG2 and JPEG 2000 scans silently fail to render.
 */
import "../kit/polyfills";
// The legacy build: the modern one needs JavaScript features (e.g. Map.getOrInsertComputed)
// that macOS 15's WebKit doesn't have yet.
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { EventBus, PDFFindController, PDFLinkService, PDFViewer } from "pdfjs-dist/legacy/web/pdf_viewer.mjs";
import "pdfjs-dist/legacy/web/pdf_viewer.css";
import { h } from "../kit/dom";
import { boxesIn, snapToWords, drawMarks, dragRect, endOf, innerRect, outlineRegion, watchMarkClicks, pageAtOffset, pageOf, regionOf, type Box, type Mark, type ReaderEngine, type ReaderView } from "./host";
import { ocrFind, ocrLayer, type OcrLine } from "./ocr";
import { advancesOf, splitIntoWords, type Advance, type FontData } from "./pdf-words";

const BASE = "/pdfjs/";
pdfjs.GlobalWorkerOptions.workerSrc = `${BASE}pdf.worker.min.mjs`;

/** Options for every document: local assets only, no scripting, no eval. */
export const DOCUMENT_OPTIONS = {
  cMapUrl: `${BASE}cmaps/`,
  cMapPacked: true,
  standardFontDataUrl: `${BASE}standard_fonts/`,
  wasmUrl: `${BASE}wasm/`,
  iccUrl: `${BASE}iccs/`,
  isEvalSupported: false,
  enableXfa: false,
  // Fonts' widths and character maps, to place the selectable text (pdf-words.ts).
  fontExtraProperties: true,
};

export const pdfEngine: ReaderEngine = {
  id: "pdf",
  formats: ["pdf"],
  async open(host, src, events) {
    const t0 = performance.now();
    const container = h("div", { class: "pdf-container", tabindex: "0", "aria-label": `${src.title}, document` });
    const viewerEl = h("div", { class: "pdfViewer" });
    container.appendChild(viewerEl);
    host.appendChild(container);
    const eventBus = new EventBus();
    const linkService = new PDFLinkService({ eventBus });
    const findController = new PDFFindController({ eventBus, linkService });
    const viewer = new PDFViewer({ container, viewer: viewerEl, eventBus, linkService, findController, removePageBorders: true, textLayerMode: 1, annotationMode: pdfjs.AnnotationMode.ENABLE });
    linkService.setViewer(viewer);
    let painted = false;
    // A region to outline survives page re-renders (PDF.js clears unknown children).
    let marked: { page: number; region: { x: number; y: number; w: number; h: number } } | null = null;
    const drawMark = (scroll: boolean) => {
      if (!marked) return;
      const div = viewer.getPageView(marked.page - 1)?.div as HTMLElement | undefined;
      if (div) {
        const m = outlineRegion(div, marked.region);
        if (scroll) m.scrollIntoView({ block: "center" });
      }
    };
    // Recognised text of scanned pages, laid over them so it can be selected and found.
    const recognized = new Map<number, OcrLine[]>();
    const text = src.text();
    void text.then((t) => {
      for (const p of t?.pages ?? []) {
        const lines = (p as { lines?: OcrLine[] }).lines;
        if (lines?.length) recognized.set(p.page, lines);
      }
    });
    // Pending marks (a capture being made), redrawn as pages render.
    let marks: Mark[] = [];
    const drawPageMarks = (n: number) => {
      const div = viewer.getPageView(n - 1)?.div as HTMLElement | undefined;
      if (div) drawMarks(div, marks, n);
    };
    // Selectable text where the printed words are (pdf-words.ts); set up before each page
    // draws, and so before its text layer.
    eventBus.on("pagerender", (e: { source?: { pdfPage?: unknown } }) => placeWords(e.source?.pdfPage));
    eventBus.on("pagerendered", (e: { pageNumber: number }) => {
      if (marked && e.pageNumber === marked.page) drawMark(false);
      drawPageMarks(e.pageNumber);
      const lines = recognized.get(e.pageNumber);
      const div = viewer.getPageView(e.pageNumber - 1)?.div as HTMLElement | undefined;
      if (lines && div) ocrLayer(div, lines);
      if (!painted && e.pageNumber === viewer.currentPageNumber) {
        painted = true;
        events.firstPaint(performance.now() - t0);
      }
    });
    eventBus.on("pagechanging", () => events.moved());
    // Pages exist only after "pagesinit": anything that moves to a page waits for it.
    // Fit to the width, and keep fitting as the reader's width changes (the window, the capture
    // panel), until the user zooms; a width of nothing (a hidden reader) is ignored.
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
    const resized = new ResizeObserver(() => refit());
    resized.observe(container);
    const data = new Uint8Array(await src.bytes());
    const task = pdfjs.getDocument({ data, ...DOCUMENT_OPTIONS });
    const doc = await task.promise;
    viewer.setDocument(doc);
    linkService.setDocument(doc);

    // Find: PDF.js searches pages in the background, reporting its state and the count.
    let lastFind = { count: 0, current: 0 };
    let settled = false;
    const waiters: (() => void)[] = [];
    const wake = () => waiters.splice(0).forEach((w) => w());
    eventBus.on("updatefindmatchescount", (e: { matchesCount: { current: number; total: number } }) => {
      lastFind = { count: e.matchesCount.total, current: e.matchesCount.current };
      wake();
    });
    eventBus.on("updatefindcontrolstate", (e: { state: number; matchesCount: { current: number; total: number } }) => {
      if (e.matchesCount) lastFind = { count: e.matchesCount.total, current: e.matchesCount.current };
      settled = e.state !== 3; // 3: still searching
      wake();
    });
    const view: ReaderView = {
      zoomIn: () => ((fit = false), (viewer.currentScale = Math.min(8, viewer.currentScale * 1.2))),
      zoomOut: () => ((fit = false), (viewer.currentScale = Math.max(0.25, viewer.currentScale / 1.2))),
      zoomReset: () => ((fit = true), refit()),
      async find(query, opts = {}) {
        settled = false;
        eventBus.dispatch("find", { source: view, type: opts.again ? "again" : "", query, caseSensitive: false, entireWord: false, highlightAll: true, findPrevious: !!opts.back, matchDiacritics: false });
        // Until the search settles with a count (or gives up after 3 s).
        const deadline = performance.now() + 3000;
        while ((!settled || (lastFind.count === 0 && performance.now() < deadline - 2000)) && performance.now() < deadline) {
          await new Promise<void>((r) => {
            waiters.push(r);
            setTimeout(r, 100);
          });
        }
        // Scanned pages: their recognised text.
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
      },
      findClear: () => eventBus.dispatch("findbarclose", { source: view }),
      goToTextOffset(offset) {
        void Promise.all([text, pagesReady]).then(([t]) => {
          if (t?.pages?.length) viewer.currentPageNumber = pageAtOffset(t.pages, offset) + 1;
        });
      },
      position: () => (doc.numPages ? `Page ${viewer.currentPageNumber} of ${doc.numPages}` : ""),
      selection() {
        const sel = window.getSelection();
        const text = sel?.toString().trim() ?? "";
        if (!sel || !text || !sel.rangeCount || !container.contains(sel.anchorNode)) return null;
        const range = sel.getRangeAt(0);
        const pageEl = (sel.anchorNode instanceof Element ? sel.anchorNode : sel.anchorNode?.parentElement)?.closest<HTMLElement>(".page");
        // Boxes on every page the selection crosses.
        const boxes: Box[] = [];
        for (const p of container.querySelectorAll<HTMLElement>(".page")) {
          if (range.intersectsNode(p)) boxes.push(...boxesIn(range, p, Number(p.dataset.pageNumber)));
        }
        return { text, page: pageEl ? Number(pageEl.dataset.pageNumber) : viewer.currentPageNumber, boxes, end: endOf(range) };
      },
      watchSelection(cb) {
        // When a drag or a keyboard selection ends (not at every step of it).
        const up = () =>
          setTimeout(() => {
            snapToWords(window.getSelection());
            cb();
          }, 0);
        const key = (e: KeyboardEvent) => e.shiftKey && setTimeout(cb, 0);
        const change = () => {
          if (!window.getSelection()?.toString().trim()) cb();
        };
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
        for (let n = 1; n <= doc.numPages; n++) {
          if (viewer.getPageView(n - 1)?.div?.isConnected) drawPageMarks(n);
        }
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
        if (!pageEl) return null;
        // Inside the page's border, where the page itself is drawn.
        const b = innerRect(pageEl);
        const x = Math.max(0, r.left - b.left), y = Math.max(0, r.top - b.top);
        const w = Math.min(b.width - x, r.right - b.left - x), h = Math.min(b.height - y, r.bottom - b.top - y);
        if (w < 4 || h < 4) return null;
        const pct = (v: number, of: number) => Math.round((v / of) * 10000) / 100;
        const n = Number(pageEl.dataset.pageNumber);
        const box = { x: pct(x, b.width), y: pct(y, b.height), w: pct(w, b.width), h: pct(h, b.height) };
        return { page: n, ...box, png: await renderRegion(doc, n, box) };
      },
      async showPlace(selectors) {
        await pagesReady;
        const page = pageOf(selectors);
        if (!page || page < 1 || page > doc.numPages) return false;
        viewer.currentPageNumber = page;
        const region = regionOf(selectors);
        if (region) {
          marked = { page, region };
          drawMark(true);
          return true;
        }
        marked = null;
        const quote = selectors.find((s) => s.type === "TextQuoteSelector")?.exact;
        if (quote) await view.find(quote.replace(/\s+/g, " ").slice(0, 200));
        return true;
      },
      destroy() {
        resized.disconnect();
        viewer.cleanup();
        void task.destroy();
        container.remove();
      },
    };
    return view;
  },
};

/* eslint-disable @typescript-eslint/no-explicit-any -- PDF.js's page proxies are untyped here */
const placed = new WeakSet<object>();
/**
 * Makes a page's text content come in words placed by their font's widths (pdf-words.ts).
 * The fonts are loaded by then: PDF.js draws a page before its text layer.
 */
function placeWords(page: any): void {
  if (!page || placed.has(page) || typeof page.streamTextContent !== "function") return;
  placed.add(page);
  const stream = page.streamTextContent.bind(page);
  page.streamTextContent = (params: unknown) => {
    const reader = stream(params).getReader();
    const fonts = new Map<string, Advance | null>();
    const advanceFor = (name: string) => {
      if (!fonts.has(name)) {
        let font: FontData | null;
        try {
          font = page.commonObjs?.has(name) ? page.commonObjs.get(name) : null;
        } catch {
          font = null;
        }
        fonts.set(name, advancesOf(font));
      }
      return fonts.get(name)!;
    };
    return new ReadableStream({
      async pull(ctl) {
        const { value, done } = await reader.read();
        if (done) return ctl.close();
        ctl.enqueue({ ...value, items: splitIntoWords(value.items, advanceFor) });
      },
      cancel: (why) => reader.cancel(why),
    });
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/**
 * Renders a region of a page (percent boxes) afresh, sharp: about 2,000 px across at most,
 * and never below twice the page's natural size.
 */
async function renderRegion(doc: pdfjs.PDFDocumentProxy, n: number, r: { x: number; y: number; w: number; h: number }): Promise<string> {
  const page = await doc.getPage(n);
  const base = page.getViewport({ scale: 1 });
  const regionW = (base.width * r.w) / 100;
  const scale = Math.max(2, Math.min(6, 2000 / Math.max(1, regionW)));
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
