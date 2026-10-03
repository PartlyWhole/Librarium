/** The image engine: the original image, zoomable; find searches its recognised text. */
import { h } from "../kit/dom";
import type { ReaderEngine, ReaderView } from "./host";

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
      destroy() {
        URL.revokeObjectURL(url);
        frame.remove();
      },
    };
    return view;
  },
};
