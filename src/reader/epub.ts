/**
 * The EPUB engine: foliate-js (vendored at a pinned commit). Book pages render in sandboxed
 * iframes that allow no scripts, so a book can't reach the app.
 */
import { h } from "../kit/dom";
import { endOf, type Mark, type ReaderEngine, type ReaderView } from "./host";

/* eslint-disable @typescript-eslint/no-explicit-any -- foliate-js has no types */
export const epubEngine: ReaderEngine = {
  id: "epub",
  formats: ["epub"],
  async open(host, src, events) {
    const t0 = performance.now();
    await import("../../vendor/foliate-js/view.js");
    const { Overlayer } = await import("../../vendor/foliate-js/overlayer.js");
    const bytes = await src.bytes();
    const view: any = document.createElement("foliate-view");
    view.classList.add("epub-view");
    const frame = h("div", { class: "epub-container", tabindex: "0", "aria-label": `${src.title}, book` }, view);
    host.appendChild(frame);
    let fontSize = 100;
    let location = "";
    let painted = false;
    // A link to the web in the book: the app asks before opening it in the browser.
    view.addEventListener("external-link", (e: any) => {
      e.preventDefault();
      document.dispatchEvent(new CustomEvent("open-link", { detail: { url: e.detail?.href_, text: e.detail?.a?.textContent ?? "" } }));
    });
    view.addEventListener("relocate", (e: any) => {
      const d = e.detail ?? {};
      location = d.tocItem?.label ? `${d.tocItem.label}${d.fraction != null ? ` · ${Math.round(d.fraction * 100)}%` : ""}` : d.fraction != null ? `${Math.round(d.fraction * 100)}%` : "";
      if (!painted) {
        painted = true;
        events.firstPaint(performance.now() - t0);
      }
      events.moved();
    });
    // Pending marks (a capture being made) are drawn as highlights by foliate's overlayer.
    view.addEventListener("draw-annotation", (e: any) => {
      const { draw, annotation } = e.detail;
      draw(Overlayer.highlight, { color: annotation.color ?? "rgb(255 196 0 / 45%)" });
    });
    let marked: Mark[] = [];
    // Selections are made inside the book's frames: listen in each as it loads.
    const selectionWatchers = new Set<() => void>();
    const watchDoc = (doc: Document) => {
      const fire = () => setTimeout(() => selectionWatchers.forEach((w) => w()), 0);
      doc.addEventListener("mouseup", fire);
      doc.addEventListener("keyup", (e) => e.shiftKey && fire());
      doc.addEventListener("selectionchange", () => {
        if (!doc.getSelection()?.toString().trim()) fire();
      });
    };
    view.addEventListener("load", (e: any) => e.detail?.doc && watchDoc(e.detail.doc));
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
      selection() {
        for (const c of view.renderer?.getContents?.() ?? []) {
          const sel = c.doc?.getSelection?.();
          const text = sel?.toString().trim();
          if (sel && text && sel.rangeCount) {
            const range = sel.getRangeAt(0);
            const cfi = view.getCFI?.(c.index, range);
            // The frame's place on screen turns the range's coordinates into the window's.
            const fb = (c.doc.defaultView?.frameElement as HTMLElement | null)?.getBoundingClientRect();
            const e = endOf(range);
            return { text, chapter: c.index, cfi, end: e && fb ? { x: e.x + fb.left, y: e.y + fb.top, bottom: e.bottom + fb.top } : e };
          }
        }
        return null;
      },
      watchSelection(cb) {
        selectionWatchers.add(cb);
        return () => selectionWatchers.delete(cb);
      },
      clearSelection() {
        for (const c of view.renderer?.getContents?.() ?? []) c.doc?.getSelection?.()?.removeAllRanges();
      },
      setMarks(marks) {
        for (const m of marked) if (m.cfi) void view.deleteAnnotation({ value: m.cfi });
        marked = marks.filter((m) => m.cfi);
        // Saved captures softer than a capture being made.
        for (const m of marked) void view.addAnnotation({ value: m.cfi, color: m.saved ? "rgb(255 196 0 / 22%)" : undefined });
      },
      onMarkClick(cb) {
        const on = (e: any) => {
          const ids = marked.filter((m) => m.saved && m.cfi === e.detail?.value).map((m) => m.id);
          if (!ids.length) return;
          const range = e.detail?.range as Range | undefined;
          const r = range?.getBoundingClientRect();
          const fb = (range?.startContainer?.ownerDocument?.defaultView?.frameElement as HTMLElement | null)?.getBoundingClientRect();
          cb(ids, { x: (r?.right ?? 0) + (fb?.left ?? 0), y: (r?.bottom ?? 0) + (fb?.top ?? 0) });
        };
        view.addEventListener("show-annotation", on);
        return () => view.removeEventListener("show-annotation", on);
      },
      async showPlace(selectors) {
        const cfi = selectors.find((s) => s.type === "FragmentSelector" && (s.value ?? "").startsWith("epubcfi("))?.value;
        if (!cfi) return false;
        await view.goTo(cfi);
        return true;
      },
      destroy() {
        view.close?.();
        frame.remove();
      },
    };
    return r;
  },
};
