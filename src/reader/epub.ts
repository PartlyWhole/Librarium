/**
 * The EPUB engine: foliate-js (vendored at a pinned commit). Book pages render in sandboxed
 * iframes that allow no scripts, so a book can't reach the app.
 */
import { h } from "../kit/dom";
import type { ReaderEngine, ReaderView } from "./host";

/* eslint-disable @typescript-eslint/no-explicit-any -- foliate-js has no types */
export const epubEngine: ReaderEngine = {
  id: "epub",
  formats: ["epub"],
  async open(host, src, events) {
    const t0 = performance.now();
    await import("../../vendor/foliate-js/view.js");
    const bytes = await src.bytes();
    const view: any = document.createElement("foliate-view");
    view.classList.add("epub-view");
    const frame = h("div", { class: "epub-container", tabindex: "0", "aria-label": `${src.title}, book` }, view);
    host.appendChild(frame);
    let fontSize = 100;
    let location = "";
    let painted = false;
    view.addEventListener("relocate", (e: any) => {
      const d = e.detail ?? {};
      location = d.tocItem?.label ? `${d.tocItem.label}${d.fraction != null ? ` · ${Math.round(d.fraction * 100)}%` : ""}` : d.fraction != null ? `${Math.round(d.fraction * 100)}%` : "";
      if (!painted) {
        painted = true;
        events.firstPaint(performance.now() - t0);
      }
      events.moved();
    });
    await view.open(new File([bytes], `${src.id}.epub`, { type: "application/epub+zip" }));
    view.renderer.setAttribute("flow", "scrolled");
    const styles = () => `html { font-size: ${fontSize}% !important; } body { line-height: 1.5; }`;
    view.renderer.setStyles?.(styles());
    await view.renderer.next?.();
    let results: { cfi: string }[] = [];
    let at = -1;
    const r: ReaderView = {
      zoomIn: () => ((fontSize = Math.min(240, fontSize + 10)), view.renderer.setStyles?.(styles())),
      zoomOut: () => ((fontSize = Math.max(60, fontSize - 10)), view.renderer.setStyles?.(styles())),
      zoomReset: () => ((fontSize = 100), view.renderer.setStyles?.(styles())),
      async find(query, opts = {}) {
        if (!opts.again) {
          results = [];
          at = -1;
          view.clearSearch?.();
          for await (const item of view.search({ query })) {
            if (item === "done") break;
            for (const s of item.subitems ?? [item]) if (s.cfi) results.push(s);
          }
        }
        if (!results.length) return { count: 0, current: 0 };
        at = opts.back ? (at - 1 + results.length) % results.length : (at + 1) % results.length;
        await view.goTo(results[at]!.cfi);
        return { count: results.length, current: at + 1 };
      },
      findClear: () => view.clearSearch?.(),
      position: () => location,
      destroy() {
        view.close?.();
        frame.remove();
      },
    };
    return r;
  },
};
