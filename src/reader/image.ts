/** The image engine: the original image, zoomable; find searches its recognised text. */
import { h } from "../kit/dom";
import { boxesIn, cropToPng, drawMarks, dragRect, endOf, outlineRegion, watchMarkClicks, regionOf, type Mark, type ReaderEngine, type ReaderView } from "./host";
import { ocrFind, ocrLayer, type OcrLine } from "./ocr";

export const imageEngine: ReaderEngine = {
  id: "image",
  formats: ["image"],
  async open(host, src, events) {
    const t0 = performance.now();
    const bytes = await src.bytes();
    const url = URL.createObjectURL(new Blob([bytes]));
    const img = h("img", { class: "image-view", alt: src.title, src: url, draggable: false });
    // The holder sizes to the image, so recognised text and regions sit on it.
    const holder = h("div", { class: "image-holder" }, img);
    const frame = h("div", { class: "image-container", tabindex: "0", "aria-label": `${src.title}, image` }, holder);
    host.appendChild(frame);
    let scale = 1;
    const apply = () => {
      img.style.width = scale === 1 ? "" : `${img.naturalWidth * scale}px`;
      img.style.maxWidth = scale === 1 ? "100%" : "none";
      requestAnimationFrame(layOut);
    };
    let lines: OcrLine[] = [];
    let marks: Mark[] = [];
    const layOut = () => {
      if (lines.length) ocrLayer(holder, lines);
      drawMarks(holder, marks);
    };
    img.addEventListener(
      "load",
      () => {
        events.firstPaint(performance.now() - t0);
        void src.text().then((t) => {
          lines = ((t?.pages?.[0] as { lines?: OcrLine[] } | undefined)?.lines ?? []) as OcrLine[];
          layOut();
        });
      },
      { once: true },
    );
    const view: ReaderView = {
      zoomIn: () => ((scale = Math.min(8, (scale === 1 ? img.clientWidth / (img.naturalWidth || 1) : scale) * 1.25)), apply()),
      zoomOut: () => ((scale = Math.max(0.1, (scale === 1 ? img.clientWidth / (img.naturalWidth || 1) : scale) / 1.25)), apply()),
      zoomReset: () => ((scale = 1), apply()),
      async find(query) {
        // Images are searchable through their recognised text.
        const hits = ocrFind(holder, query);
        hits[0]?.scrollIntoView({ block: "center" });
        return { count: hits.length, current: hits.length ? 1 : 0 };
      },
      findClear: () => void ocrFind(holder, ""),
      position: () => (img.naturalWidth ? `${img.naturalWidth} × ${img.naturalHeight}` : ""),
      selection() {
        const sel = window.getSelection();
        const text = sel?.toString().trim() ?? "";
        if (!sel || !text || !sel.rangeCount || !frame.contains(sel.anchorNode)) return null;
        const range = sel.getRangeAt(0);
        return { text, boxes: boxesIn(range, holder), end: endOf(range) };
      },
      watchSelection(cb) {
        const up = () => setTimeout(cb, 0);
        const key = (e: KeyboardEvent) => e.shiftKey && setTimeout(cb, 0);
        const change = () => {
          if (!window.getSelection()?.toString().trim()) cb();
        };
        frame.addEventListener("mouseup", up);
        frame.addEventListener("keyup", key);
        document.addEventListener("selectionchange", change);
        return () => {
          frame.removeEventListener("mouseup", up);
          frame.removeEventListener("keyup", key);
          document.removeEventListener("selectionchange", change);
        };
      },
      clearSelection: () => window.getSelection()?.removeAllRanges(),
      onMarkClick: (cb) => watchMarkClicks(frame, cb),
      setMarks(m) {
        marks = m;
        drawMarks(holder, marks);
      },
      async pickRegion() {
        const r = await dragRect(frame);
        if (!r) return null;
        const b = img.getBoundingClientRect();
        const x = Math.max(0, r.left - b.left), y = Math.max(0, r.top - b.top);
        const w = Math.min(b.width - x, r.width), h = Math.min(b.height - y, r.height);
        if (w <= 0 || h <= 0) return null;
        const sx = img.naturalWidth / b.width, sy = img.naturalHeight / b.height;
        const pct = (v: number, of: number) => Math.round((v / of) * 10000) / 100;
        return { x: pct(x, b.width), y: pct(y, b.height), w: pct(w, b.width), h: pct(h, b.height), png: cropToPng(img, x * sx, y * sy, w * sx, h * sy) };
      },
      async showPlace(selectors) {
        const region = regionOf(selectors);
        if (region) {
          outlineRegion(holder, region).scrollIntoView({ block: "center" });
          return true;
        }
        const quote = selectors.find((s) => s.type === "TextQuoteSelector")?.exact;
        if (quote) return ocrFind(holder, quote.split("\n")[0]!.slice(0, 80)).length > 0;
        return false;
      },
      destroy() {
        URL.revokeObjectURL(url);
        frame.remove();
      },
    };
    return view;
  },
};
