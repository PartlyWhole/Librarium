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
import { boxesIn, boxesPlace, caretIn, rangeEditor, regionEditor, snapStart, snapEnd, type EditPart, snapToWords, drawMarks, dragRect, endOf, flashPlace, innerRect, outlineRegion, watchMarkClicks, pageAtOffset, pageOf, regionOf, type Box, type Mark, type ReaderEngine, type ReaderView } from "./host";
import { ocrFind, ocrLayer, type OcrLine } from "./ocr";
import { advancesOf, splitIntoWords, type Advance, type FontData } from "./pdf-words";
import { alignToInk } from "./pdf-ink";

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
    // A passage shown (Show) is brought out on its lines instead, for a moment.
    let marked: { page: number; region: { x: number; y: number; w: number; h: number }; boxes?: Box[] } | null = null;
    // While a capture's parts are edited, places are shown without outlines (the parts are drawn).
    let editingParts = false;
    const drawMark = (scroll: boolean) => {
      if (!marked) return;
      const div = viewer.getPageView(marked.page - 1)?.div as HTMLElement | undefined;
      if (!div) return;
      if (marked.boxes) {
        flashPlace(div, marked.boxes, marked.page);
        if (scroll) {
          // The passage's middle to the middle of the view.
          const b = innerRect(div);
          const mid = b.top + ((marked.region.y + marked.region.h / 2) / 100) * b.height;
          const c = container.getBoundingClientRect();
          container.scrollTop += mid - (c.top + c.height / 2);
        }
        const shown = marked;
        setTimeout(() => {
          if (marked === shown) marked = null;
        }, 2500);
        return;
      }
      const m = outlineRegion(div, marked.region);
      if (scroll) m.scrollIntoView({ block: "center" });
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
    // Scanned pages (text invisible over a picture): the text is put on the words seen (pdf-ink.ts),
    // after the page and its text are drawn, and again after a zoom.
    const inkTimers = new Map<number, ReturnType<typeof setTimeout>>();
    const onInk = (n: number) => {
      clearTimeout(inkTimers.get(n));
      inkTimers.set(n, setTimeout(() => {
        const pv = viewer.getPageView(n - 1) as { div?: HTMLElement; pdfPage?: unknown } | undefined;
        if (!pv?.div || !pv.pdfPage) return;
        void invisibleText(pv.pdfPage).then((yes) => {
          if (yes && pv.div!.querySelector(".textLayer span")) alignToInk(pv.div!);
        });
      }, 30));
    };
    eventBus.on("textlayerrendered", (e: { pageNumber: number }) => onInk(e.pageNumber));
    eventBus.on("pagerendered", (e: { pageNumber: number }) => {
      onInk(e.pageNumber);
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
    // Until PDF.js has loaded a page it is laid out at the first page's size; where the first
    // page differs (a JSTOR cover page), a place scrolled to moves as the real sizes arrive.
    // The pages up to a place are sized before going there.
    const sizedTo = async (n: number) => {
      for (let i = 1; i <= n; i++) {
        const pv = viewer.getPageView(i - 1) as { pdfPage?: unknown; setPdfPage(p: unknown): void } | undefined;
        if (pv && !pv.pdfPage) pv.setPdfPage(await doc.getPage(i));
      }
    };
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
    // A range's text, with its page and its boxes on every page it crosses.
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
        return selOf(sel.getRangeAt(0));
      },
      editParts(parts, onChange) {
        // The parts as edited so far (a page that renders again shows them where they are now).
        let current = parts.map((p) => ({ ...p }));
        editingParts = true;
        // The capture's place, outlined when it was shown, would sit under what is being edited.
        const clearPlace = () => {
          marked = null;
          container.querySelectorAll(".region-mark, .place-mark").forEach((n) => n.remove());
        };
        clearPlace();
        let editors: { destroy(): void }[] = [];
        let dragging = false;
        const pageDiv = (n: number) => viewer.getPageView(n - 1)?.div as HTMLElement | undefined;
        const layerAt = (x: number, y: number) =>
          [...container.querySelectorAll<HTMLElement>(".page")].find((p) => {
            const b = p.getBoundingClientRect();
            return y >= b.top && y <= b.bottom && x >= b.left - 40 && x <= b.right + 40;
          })?.querySelector<HTMLElement>(".textLayer") ?? null;
        // A text part's range, from where it was drawn: its first box's start to its last's end.
        const rangeOf = (p: EditPart): Range | null => {
          const boxes = p.boxes ?? [];
          if (!boxes.length) return null;
          const at = (b: Box, right: boolean) => {
            const d = pageDiv(b.page ?? p.page ?? 1);
            const layer = d?.querySelector<HTMLElement>(".textLayer");
            if (!d || !layer) return null;
            const r = innerRect(d);
            return caretIn(document, layer, r.left + (r.width * (right ? b.x + b.w - 0.3 : b.x + 0.3)) / 100, r.top + (r.height * (b.y + b.h / 2)) / 100);
          };
          const a = at(boxes[0]!, false);
          const z = at(boxes[boxes.length - 1]!, true);
          if (!a || !z) return null;
          const r = document.createRange();
          try {
            r.setStart(a.node, snapStart(a.node, a.offset));
            r.setEnd(z.node, snapEnd(z.node, z.offset));
          } catch {
            return null;
          }
          return r.collapsed ? null : r;
        };
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
              edges: { bounds: () => container.getBoundingClientRect(), margin: 28, delay: 0, repeat: 30, nudge: (_dx: number, dy: number) => void (container.scrollTop += dy * 20) },
            }));
          }
        };
        // Pages render as they come into view (and again on zoom): find the parts on them again.
        const rendered = () => !dragging && build();
        eventBus.on("textlayerrendered", rendered);
        build();
        return {
          update(next) {
            current = next.map((p) => ({ ...p }));
            build();
          },
          stop() {
            editingParts = false;
            clearPlace();
            eventBus.off("textlayerrendered", rendered);
            editors.forEach((e) => e.destroy());
            editors = [];
          },
        };
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
        await sizedTo(Math.min(doc.numPages, Math.max(boxesPlace(selectors)?.page ?? 0, pageOf(selectors) ?? 0)));
        // Where it was drawn: straight there, outlined (a text search can miss or find another).
        const drawn = boxesPlace(selectors);
        if (drawn?.page && drawn.page >= 1 && drawn.page <= doc.numPages) {
          viewer.currentPageNumber = drawn.page;
          marked = { page: drawn.page, region: drawn.region, boxes: selectors.find((x) => x.type === "librarium:boxes")?.boxes };
          drawMark(true);
          if (editingParts) {
            marked = null;
            container.querySelectorAll(".region-mark, .place-mark").forEach((n) => n.remove());
          }
          return true;
        }
        const page = pageOf(selectors);
        if (!page || page < 1 || page > doc.numPages) return false;
        viewer.currentPageNumber = page;
        const region = regionOf(selectors);
        if (region) {
          marked = { page, region };
          drawMark(true);
          if (editingParts) {
            marked = null;
            container.querySelectorAll(".region-mark").forEach((n) => n.remove());
          }
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
const invisible = new WeakMap<object, Promise<boolean>>();
/** Whether a page's text is drawn invisibly (render mode 3 or 7): recognised text over a scan. */
function invisibleText(page: any): Promise<boolean> {
  let p = invisible.get(page);
  if (!p) {
    p = (page.getOperatorList() as Promise<{ fnArray: number[]; argsArray: unknown[][] }>).then(
      (ops) => ops.fnArray.some((f, i) => f === pdfjs.OPS.setTextRenderingMode && [3, 7].includes(Number(ops.argsArray[i]?.[0]))),
      () => false,
    );
    invisible.set(page, p);
  }
  return p;
}
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
