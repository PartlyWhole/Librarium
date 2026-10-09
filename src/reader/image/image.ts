/** Images: the original, zoomable, with its recognised text laid over it as selectable lines. */
import { h } from "../../ui/dom";
import { caretIn, rangeEditor, rangeFromBoxes, regionEditor } from "../handles";
import { boxesIn, cropToPng, dragRect, drawMarks, endOf, outlineRegion, regionOn, watchMarkClicks } from "../marks";
import { ocrFind, ocrLayer, type OcrLine } from "../ocr";
import { regionOf, type Engine, type EditPart, type Mark, type ReaderView } from "../types";

export const openImage: Engine = async (host, src, events) => {
  const t0 = performance.now();
  const url = URL.createObjectURL(new Blob([await src.bytes()]));
  const img = h("img", { class: "image-view", alt: src.title, src: url, draggable: false });
  // The holder sizes to the image, so recognised text, marks and regions sit on it.
  const holder = h("div", { class: "image-holder" }, img);
  const frame = h("div", { class: "image-container", tabindex: "0", "aria-label": `${src.title}, image` }, holder);
  host.appendChild(frame);
  // 0: fit the width; otherwise a scale of the natural size.
  let scale = 0;
  let lines: OcrLine[] = [];
  let marks: Mark[] = [];
  let editingParts = false;
  const layOut = () => {
    if (lines.length) ocrLayer(holder, lines);
    drawMarks(holder, marks);
  };
  const apply = () => {
    img.style.width = scale ? `${img.naturalWidth * scale}px` : "";
    img.style.maxWidth = scale ? "none" : "100%";
    requestAnimationFrame(layOut);
  };
  const zoom = (k: number) => {
    const now = scale || img.clientWidth / (img.naturalWidth || 1);
    scale = Math.max(0.25, Math.min(8, now * k));
    apply();
  };
  img.addEventListener("load", () => {
    events.firstPaint(performance.now() - t0);
    void src.text().then((t) => {
      lines = t?.pages?.[0]?.lines ?? [];
      layOut();
    });
  }, { once: true });
  const resized = new ResizeObserver(() => layOut());
  resized.observe(holder);

  let hits: HTMLElement[] = [];
  let at = 0;
  const showHit = () => {
    hits.forEach((x, i) => x.classList.toggle("ocr-now", i === at));
    hits[at]?.scrollIntoView({ block: "center" });
  };
  const sel = (r: Range) => ({ text: r.toString().trim(), boxes: boxesIn(r, holder), end: endOf(r) });
  const crop = (r: { x: number; y: number; w: number; h: number }) => {
    const sx = img.naturalWidth / 100;
    const sy = img.naturalHeight / 100;
    return cropToPng(img, r.x * sx, r.y * sy, r.w * sx, r.h * sy);
  };

  const view: ReaderView = {
    zoomIn: () => zoom(1.2),
    zoomOut: () => zoom(1 / 1.2),
    zoomReset: () => ((scale = 0), apply()),
    async find(query, opts = {}) {
      if (!opts.again || !hits.length) {
        hits = ocrFind(holder, query);
        at = 0;
      } else at = (at + (opts.back ? hits.length - 1 : 1)) % hits.length;
      showHit();
      return { count: hits.length, current: hits.length ? at + 1 : 0 };
    },
    findClear: () => void (hits = ocrFind(holder, "")),
    position: () => (img.naturalWidth ? `${img.naturalWidth} × ${img.naturalHeight}` : ""),
    selection() {
      const s = window.getSelection();
      if (!s?.rangeCount || !s.toString().trim() || !frame.contains(s.anchorNode)) return null;
      return sel(s.getRangeAt(0));
    },
    watchSelection(cb) {
      const up = () => setTimeout(cb, 0);
      const key = (e: KeyboardEvent) => e.shiftKey && setTimeout(cb, 0);
      const change = () => !window.getSelection()?.toString().trim() && cb();
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
      const box = r && regionOn(img, r);
      if (!box) return null;
      const k = img.naturalWidth / img.getBoundingClientRect().width;
      const { x, y, w, h: hh, px } = box;
      return { x, y, w, h: hh, png: cropToPng(img, px.x * k, px.y * k, px.width * k, px.height * k) };
    },
    async showPlace(selectors) {
      const region = regionOf(selectors);
      if (region) {
        const outline = outlineRegion(holder, region);
        outline.scrollIntoView({ block: "center" });
        if (editingParts) outline.remove();
        return true;
      }
      const quote = selectors.find((s) => s.type === "TextQuoteSelector")?.exact;
      if (!quote) return false;
      hits = ocrFind(holder, quote.split("\n")[0]!.slice(0, 80));
      at = 0;
      showHit();
      return hits.length > 0;
    },
    editParts(parts, onChange) {
      let current = parts.map((p) => ({ ...p }));
      editingParts = true;
      holder.querySelectorAll(".region-mark").forEach((n) => n.remove());
      let editors: { destroy(): void }[] = [];
      const layer = () => holder.querySelector<HTMLElement>(".ocr-layer");
      const rangeOf = (p: EditPart) => {
        const l = layer();
        const b = holder.getBoundingClientRect();
        return l ? rangeFromBoxes(p.boxes ?? [], (q, right) => caretIn(document, l, b.left + (b.width * (right ? q.x + q.w - 0.3 : q.x + 0.3)) / 100, b.top + (b.height * (q.y + q.h / 2)) / 100)) : null;
      };
      const build = () => {
        editors.forEach((e) => e.destroy());
        editors = [];
        for (const p of current) {
          if (p.region) {
            editors.push(regionEditor({ over: holder, region: p.region, onDrag: (r) => onChange({ key: p.key, done: false, region: r }), onDone: (r) => ((p.region = r), onChange({ key: p.key, done: true, region: { ...r, png: crop(r) } })) }));
            continue;
          }
          const range = rangeOf(p);
          const l = layer();
          if (!range || !l) continue;
          editors.push(rangeEditor({
            overlay: frame,
            range,
            screenRects: (r) => [...r.getClientRects()],
            caretAt: (x, y) => caretIn(document, l, x, y),
            onDrag: (r) => onChange({ key: p.key, done: false, text: sel(r) }),
            onDone: (r) => {
              const t = sel(r);
              p.boxes = t.boxes;
              onChange({ key: p.key, done: true, text: t });
            },
            edges: { bounds: () => frame.getBoundingClientRect(), margin: 28, delay: 0, repeat: 30, nudge: (_dx, dy) => void (frame.scrollTop += dy * 20) },
          }));
        }
      };
      build();
      return {
        update(next) {
          current = next.map((p) => ({ ...p }));
          build();
        },
        stop() {
          editingParts = false;
          holder.querySelectorAll(".region-mark").forEach((n) => n.remove());
          editors.forEach((e) => e.destroy());
          editors = [];
        },
      };
    },
    destroy() {
      resized.disconnect();
      URL.revokeObjectURL(url);
      frame.remove();
    },
  };
  return view;
};
