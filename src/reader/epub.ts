/**
 * The EPUB engine: foliate-js (vendored at a pinned commit). Book pages render in iframes; the
 * book's own scripts never run (epub-safe.ts, decision 0043), so a book can't reach the app.
 *
 * Foliate shows one chapter (spine section) at a time when scrolling. Reading on is ours:
 * scrolling on past a chapter's end (or start), Space/Page Down/Page Up, ← and →, and a bar
 * with the previous and next chapter and the contents.
 */
import { h } from "../kit/dom";
import { endOf, type Mark, type ReaderEngine, type ReaderView } from "./host";
import { isMarkup, safeMarkup } from "./epub-safe";

/* eslint-disable @typescript-eslint/no-explicit-any -- foliate-js has no types */
export const epubEngine: ReaderEngine = {
  id: "epub",
  formats: ["epub"],
  async open(host, src, events) {
    const t0 = performance.now();
    const { makeBook } = await import("../../vendor/foliate-js/view.js");
    const { Overlayer } = await import("../../vendor/foliate-js/overlayer.js");
    const bytes = await src.bytes();
    const view: any = document.createElement("foliate-view");
    view.classList.add("epub-view");
    const prevBtn = h("button", { class: "link-button small", type: "button", title: "Previous chapter (←)", onclick: () => void view.renderer?.prevSection() }, "‹ Previous chapter");
    const nextBtn = h("button", { class: "link-button small", type: "button", title: "Next chapter (→)", onclick: () => void view.renderer?.nextSection() }, "Next chapter ›");
    const contents = h("select", { "aria-label": "Contents", onchange: () => contents.value && void view.goTo(contents.value) });
    const bar = h("div", { class: "epub-bar", role: "navigation", "aria-label": "Chapters" }, prevBtn, contents, nextBtn);
    const frame = h("div", { class: "epub-container", tabindex: "0", "aria-label": `${src.title}, book` }, view, bar);
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
      showChapter(d);
      events.moved();
    });
    // Pending marks (a capture being made) are drawn as highlights by foliate's overlayer.
    view.addEventListener("draw-annotation", (e: any) => {
      const { draw, annotation } = e.detail;
      draw(Overlayer.highlight, { color: annotation.color ?? "rgb(255 196 0 / 45%)" });
    });
    // The chapter bar follows the reading place.
    function showChapter(d: any) {
      const sections: any[] = view.book?.sections ?? [];
      const index: number = d.section?.current ?? -1;
      const linear = (i: number) => sections[i] && sections[i].linear !== "no";
      prevBtn.disabled = !sections.some((_, i) => i < index && linear(i));
      nextBtn.disabled = !sections.some((_, i) => i > index && linear(i));
      const href = d.tocItem?.href;
      if (href && [...contents.options].some((o) => o.value === href)) contents.value = href;
      else if (!href) contents.selectedIndex = -1;
    }
    // Scrolling on at a chapter's end (or start) turns to the next (or previous) one. The
    // scroll that carried the reader to the edge (a trackpad's momentum) doesn't count: a new
    // push after a pause does, once it has gone far enough to be deliberate.
    let lastWheel = 0;
    let edge = 0;
    let armed = false;
    let pushed = 0;
    function onWheel(e: WheelEvent) {
      const now = performance.now();
      const gap = now - lastWheel;
      lastWheel = now;
      const r = view.renderer;
      const dir = Math.sign(e.deltaY);
      if (!r || !dir || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
      const atEdge = dir > 0 ? r.viewSize - r.end <= 2 : r.start <= 1;
      if (!atEdge) {
        edge = 0;
        return;
      }
      if (edge !== dir) {
        edge = dir;
        armed = gap > 200;
        pushed = 0;
      } else if (!armed && gap > 200) armed = true;
      if (!armed) return;
      pushed += Math.abs(e.deltaY) * (e.deltaMode === 1 ? 16 : 1);
      if (pushed < 100) return;
      edge = 0;
      armed = false;
      void (dir > 0 ? r.next() : r.prev());
    }
    function onKey(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.closest?.("select, input, textarea, button, [contenteditable=true]"))) return;
      const r = view.renderer;
      if (!r) return;
      const go: (() => unknown) | null =
        e.key === "PageDown" || (e.key === " " && !e.shiftKey) ? () => r.next()
        : e.key === "PageUp" || (e.key === " " && e.shiftKey) ? () => r.prev()
        : e.key === "ArrowRight" && !e.shiftKey ? () => r.nextSection()
        : e.key === "ArrowLeft" && !e.shiftKey ? () => r.prevSection()
        : null;
      if (!go) return;
      e.preventDefault();
      void go();
    }
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
    view.addEventListener("load", (e: any) => {
      const doc: Document | undefined = e.detail?.doc;
      if (!doc) return;
      watchDoc(doc);
      doc.addEventListener("wheel", onWheel, { passive: true });
      doc.addEventListener("keydown", onKey);
    });
    view.addEventListener("wheel", onWheel, { passive: true });
    frame.addEventListener("keydown", onKey);
    const book: any = await makeBook(new File([bytes], `${src.id}.epub`, { type: "application/epub+zip" }));
    // The book's script files are never loaded, and every page is cleaned before it is shown.
    book.transformTarget?.addEventListener("load", (e: any) => {
      if (e.detail.isScript) e.detail.allow = false;
    });
    book.transformTarget?.addEventListener("data", (e: any) => {
      const type = String(e.detail.type ?? "");
      if (!isMarkup(type)) return;
      e.detail.data = Promise.resolve(e.detail.data).then((d: unknown) => (typeof d === "string" ? safeMarkup(d, type) : d));
    });
    await view.open(book);
    // The contents, nested entries indented.
    const entries: { label: string; href: string }[] = [];
    const walk = (items: any[] | undefined, depth: number) => {
      for (const t of items ?? []) {
        if (t?.href) entries.push({ label: `${"\u2003".repeat(depth)}${String(t.label ?? "").trim() || "Untitled"}`, href: t.href });
        walk(t?.subitems, depth + 1);
      }
    };
    walk(view.book?.toc, 0);
    contents.append(...entries.map((t) => h("option", { value: t.href }, t.label)));
    contents.hidden = !entries.length;
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
        view.removeEventListener("wheel", onWheel);
        view.close?.();
        frame.remove();
      },
    };
    return r;
  },
};
