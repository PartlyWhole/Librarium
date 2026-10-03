/** The image engine: the original image, zoomable; find searches its recognised text. */
import { h } from "../kit/dom";
import { cropToPng, dragRect, outlineRegion, regionOf, type ReaderEngine, type ReaderView } from "./host";

export const imageEngine: ReaderEngine = {
  id: "image",
  formats: ["image"],
  async open(host, src, events) {
    const t0 = performance.now();
    const bytes = await src.bytes();
    const url = URL.createObjectURL(new Blob([bytes]));
    const img = h("img", { class: "image-view", alt: src.title, src: url, draggable: false });
    const frame = h("div", { class: "image-container", tabindex: "0", "aria-label": `${src.title}, image` }, img);
    host.appendChild(frame);
    let scale = 1;
    const apply = () => {
      img.style.width = scale === 1 ? "" : `${img.naturalWidth * scale}px`;
      img.style.maxWidth = scale === 1 ? "100%" : "none";
    };
    img.addEventListener("load", () => events.firstPaint(performance.now() - t0), { once: true });
    const view: ReaderView = {
      zoomIn: () => ((scale = Math.min(8, (scale === 1 ? img.clientWidth / (img.naturalWidth || 1) : scale) * 1.25)), apply()),
      zoomOut: () => ((scale = Math.max(0.1, (scale === 1 ? img.clientWidth / (img.naturalWidth || 1) : scale) / 1.25)), apply()),
      zoomReset: () => ((scale = 1), apply()),
      async find(query) {
        // Images are searchable through their recognised text.
        const t = await src.text();
        const all = (t?.pages ?? []).map((p) => p.text).join("\n").toLowerCase();
        const q = query.toLowerCase();
        let count = 0;
        for (let i = all.indexOf(q); q && i >= 0; i = all.indexOf(q, i + q.length)) count++;
        return { count, current: count ? 1 : 0 };
      },
      findClear() {},
      position: () => (img.naturalWidth ? `${img.naturalWidth} × ${img.naturalHeight}` : ""),
      selection: () => null,
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
        if (!region) return false;
        const wrap = img.parentElement!;
        let holder = wrap.querySelector<HTMLElement>(".image-holder");
        if (!holder) {
          holder = document.createElement("div");
          holder.className = "image-holder";
          img.replaceWith(holder);
          holder.appendChild(img);
        }
        outlineRegion(holder, region).scrollIntoView({ block: "center" });
        return true;
      },
      destroy() {
        URL.revokeObjectURL(url);
        frame.remove();
      },
    };
    return view;
  },
};
