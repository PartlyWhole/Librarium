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
import { cropToPng, dragRect, outlineRegion, pageAtOffset, pageOf, regionOf, type ReaderEngine, type ReaderView } from "./host";

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
    const viewer = new PDFViewer({ container, viewer: viewerEl, eventBus, linkService, findController, removePageBorders: false, textLayerMode: 1, annotationMode: pdfjs.AnnotationMode.ENABLE });
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
    eventBus.on("pagerendered", (e: { pageNumber: number }) => {
      if (marked && e.pageNumber === marked.page) drawMark(false);
      if (!painted && e.pageNumber === viewer.currentPageNumber) {
        painted = true;
        events.firstPaint(performance.now() - t0);
      }
    });
    eventBus.on("pagechanging", () => events.moved());
    // Pages exist only after "pagesinit": anything that moves to a page waits for it.
    const pagesReady = new Promise<void>((resolve) =>
      eventBus.on("pagesinit", () => {
        viewer.currentScaleValue = "page-width";
        resolve();
      }),
    );
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
    const text = src.text();
    const view: ReaderView = {
      zoomIn: () => (viewer.currentScale = Math.min(8, viewer.currentScale * 1.2)),
      zoomOut: () => (viewer.currentScale = Math.max(0.25, viewer.currentScale / 1.2)),
      zoomReset: () => (viewer.currentScaleValue = "page-width"),
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
        if (!sel || !text || !container.contains(sel.anchorNode)) return null;
        const pageEl = (sel.anchorNode instanceof Element ? sel.anchorNode : sel.anchorNode?.parentElement)?.closest<HTMLElement>(".page");
        return { text, page: pageEl ? Number(pageEl.dataset.pageNumber) : viewer.currentPageNumber };
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
        const canvas = pageEl?.querySelector("canvas");
        if (!pageEl || !canvas) return null;
        const b = pageEl.getBoundingClientRect();
        const x = Math.max(0, r.left - b.left), y = Math.max(0, r.top - b.top);
        const w = Math.min(b.width - x, r.width), h = Math.min(b.height - y, r.height);
        const sx = canvas.width / b.width, sy = canvas.height / b.height;
        const pct = (v: number, of: number) => Math.round((v / of) * 10000) / 100;
        return { page: Number(pageEl.dataset.pageNumber), x: pct(x, b.width), y: pct(y, b.height), w: pct(w, b.width), h: pct(h, b.height), png: cropToPng(canvas, x * sx, y * sy, w * sx, h * sy) };
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
        viewer.cleanup();
        void task.destroy();
        container.remove();
      },
    };
    return view;
  },
};
