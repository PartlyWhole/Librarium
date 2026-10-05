/** The image engine: the original image, zoomable; find searches its recognised text. */
import { h } from "../kit/dom";
import { boxesIn, caretIn, cropToPng, drawMarks, dragRect, endOf, outlineRegion, rangeEditor, regionEditor, snapEnd, snapStart, watchMarkClicks, regionOf, type Box, type EditPart, type Mark, type ReaderEngine, type ReaderView } from "./host";
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
      editParts(parts, onChange) {
        let current = parts;
        let editors: { destroy(): void }[] = [];
        const sel = (r: Range) => ({ text: r.toString().trim(), boxes: boxesIn(r, holder), end: endOf(r) });
        const crop = (r: { x: number; y: number; w: number; h: number }) => {
          const sx = img.naturalWidth / 100;
          const sy = img.naturalHeight / 100;
          return cropToPng(img, r.x * sx, r.y * sy, r.w * sx, r.h * sy);
        };
        const layer = () => holder.querySelector<HTMLElement>(".ocr-layer");
        const rangeOf = (p: EditPart): Range | null => {
          const boxes: Box[] = p.boxes ?? [];
          const l = layer();
          if (!boxes.length || !l) return null;
          const b = holder.getBoundingClientRect();
          const at = (q: Box, right: boolean) => caretIn(document, l, b.left + (b.width * (right ? q.x + q.w - 0.3 : q.x + 0.3)) / 100, b.top + (b.height * (q.y + q.h / 2)) / 100);
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
              editors.push(regionEditor({ over: holder, region: p.region, onDrag: (r) => onChange({ key: p.key, done: false, region: r }), onDone: (r) => onChange({ key: p.key, done: true, region: { ...r, png: crop(r) } }) }));
              continue;
            }
            const range = rangeOf(p);
            const l = layer();
            if (!range || !l) continue;
            editors.push(rangeEditor({ overlay: frame, range, screenRects: (r) => [...r.getClientRects()], caretAt: (x, y) => caretIn(document, l, x, y), onDrag: (r) => onChange({ key: p.key, done: false, text: sel(r) }), onDone: (r) => onChange({ key: p.key, done: true, text: sel(r) }), edges: { bounds: () => frame.getBoundingClientRect(), margin: 28, delay: 0, repeat: 30, nudge: (_dx: number, dy: number) => void (frame.scrollTop += dy * 20) } }));
          }
        };
        build();
        return {
          update(next) {
            current = next;
            build();
          },
          stop() {
            editors.forEach((e) => e.destroy());
            editors = [];
          },
        };
      },
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
