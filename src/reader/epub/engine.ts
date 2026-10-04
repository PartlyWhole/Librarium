/**
 * The EPUB engine: Readium's navigator (decision 0045, plan docs/plans/epub-readium.md).
 *
 * - The book is served from memory by the streamer (epub/streamer.ts); its pages are made
 *   safe there (epub-safe.ts).
 * - Readium lays it out (Readium CSS): pages or scrolling, page turns across chapters, the
 *   reading settings.
 * - Captures keep their format: a selection gives the same EPUB CFI as before (spine-item
 *   CFIs from the package document + the range in the page), so older captures still resolve.
 *   Marks and find are drawn with the CSS Custom Highlight API inside Readium's frames.
 */
import { EpubNavigator, EpubPreferences, type EpubNavigatorListeners } from "@readium/navigator";
import { Locator, LocatorLocations, LocatorText, Link } from "@readium/shared";
import * as CFI from "../../../vendor/foliate-js/epubcfi.js";
import { List } from "lucide";
import { h } from "../../kit/dom";
import { icon } from "../../kit/icon";
import { endOf, snapToWords, type Mark, type ReaderEngine, type ReaderView } from "../host";
import { openBook } from "./streamer";
import { settingsPanel, toPreferences, readSettings, themeOf, THEMES, type ReadingSettings } from "./settings";

/* eslint-disable @typescript-eslint/no-explicit-any -- Readium's frame managers are internal */

const PLACE = (id: string) => `reader.place.${id}`;

export const readiumEngine: Pick<ReaderEngine, "open"> = {
  async open(host, src, events) {
    const t0 = performance.now();
    const book = await openBook(await src.bytes(), src.id);
    const store = src.store;
    let settings = readSettings(store);

    // Layout, after Apple Books: the page under a running head (the chapter), arrows at the
    // sides that show while the pointer moves, and a quiet line under the page (pages left in
    // the chapter, how far through the book). Contents and Aa go in the toolbar (controls),
    // which hides while reading (immersive).
    const stage = h("div", { class: "epub-stage" });
    const head = h("div", { class: "epub-head", "aria-hidden": "true" });
    const left = h("span", { class: "epub-left" });
    const pct = h("span", { class: "epub-pct" });
    const foot = h("div", { class: "epub-foot", "aria-live": "polite" }, h("span"), left, pct);
    const prevBtn = h("button", { class: "epub-arrow prev", type: "button", title: "Previous page (←)", "aria-label": "Previous page", onclick: () => nav.goLeft(false, done) }, "‹");
    const nextBtn = h("button", { class: "epub-arrow next", type: "button", title: "Next page (→)", "aria-label": "Next page", onclick: () => nav.goRight(false, done) }, "›");
    const frame = h("div", { class: "epub-container", tabindex: "0", "aria-label": `${src.title}, book` }, head, stage, foot, prevBtn, nextBtn);
    host.appendChild(frame);
    const contentsBtn = h("button", { class: "icon-button", type: "button", title: "Contents", "aria-label": "Contents", "aria-expanded": "false", onclick: () => togglePopover("contents") }, icon(List));
    contentsBtn.hidden = !book.toc.length;
    const aa = h("button", { class: "epub-aa", type: "button", title: "Reading settings", "aria-label": "Reading settings", "aria-expanded": "false", onclick: () => togglePopover("settings") }, "Aa");

    // Where the reader is.
    let current: Locator | undefined;
    let painted = false;
    let saveTimer: ReturnType<typeof setTimeout> | undefined;
    const tocFor = (loc: Locator) => {
      const path = decodeURIComponent(loc.href.split("#")[0]!);
      let best: (typeof book.toc)[number] | undefined;
      for (const t of book.toc) if (t.href.split("#")[0] === path) best ??= t;
      return best;
    };
    const describe = (loc: Locator | undefined) => {
      if (!loc) return "";
      const pos = loc.locations.position;
      if (book.fixed && pos) return `Page ${pos} of ${book.positions.length}`;
      const pct = loc.locations.totalProgression !== undefined ? `${Math.round(loc.locations.totalProgression * 100)}%` : "";
      const title = tocFor(loc)?.title ?? loc.title;
      return [title, pct].filter(Boolean).join(" · ");
    };

    // Frames and what is drawn in them.
    const watchers = new Set<() => void>();
    const pointerWatchers = new Set<(at: { x: number; y: number }) => void>();
    const chromeWatchers = new Set<(wanted: boolean) => void>();
    const markClickers = new Set<(ids: string[], at: { x: number; y: number }) => void>();
    let marks: Mark[] = [];
    let findState: { query: string; results: Found[]; at: number } | null = null;
    const frames = (): { win: Window; doc: Document; el: HTMLIFrameElement; index: number }[] => {
      const out: { win: Window; doc: Document; el: HTMLIFrameElement; index: number }[] = [];
      for (const f of ((nav as any)._cframes ?? []) as any[]) {
        const win: Window | undefined = f?.window;
        const doc = win?.document;
        if (!doc || !f.iframe) continue;
        const path = doc.querySelector("meta[name=librarium-href]")?.getAttribute("content") ?? "";
        out.push({ win: win!, doc, el: f.iframe, index: book.spine.findIndex((s) => s.href === path) });
      }
      return out;
    };
    const spineSteps = book.spine.map((s) => lastStep(s.cfi));
    const resolveCFI = (cfi: string) => {
      try {
        const parts = CFI.parse(cfi);
        const top = (parts.parent ?? parts).shift();
        const index = spineSteps.indexOf(top?.at(-1)?.index);
        return { index, range: (doc: Document) => CFI.toRange(doc, parts) as Range };
      } catch {
        return null;
      }
    };
    const draw = () => {
      for (const f of frames()) {
        const reg = (f.win as any).CSS?.highlights;
        const H = (f.win as any).Highlight;
        if (!reg || !H) continue;
        const saved: Range[] = [];
        const pending: Range[] = [];
        for (const m of marks) {
          const r = m.cfi ? resolveCFI(m.cfi) : null;
          if (!r || r.index !== f.index) continue;
          try {
            (m.saved ? saved : pending).push(r.range(f.doc));
          } catch {
            /* a place that isn't in this page any more */
          }
        }
        reg.set("lib-saved", new H(...saved));
        reg.set("lib-pending", new H(...pending));
        const found = findState ? findInDoc(f.doc, findState.query) : [];
        const now = findState?.results[findState.at];
        const nowIndex = now && book.spine[f.index]?.href === now.path ? now.nth : -1;
        reg.set("lib-find", new H(...found.filter((_, i) => i !== nowIndex)));
        reg.set("lib-find-now", new H(...(found[nowIndex] ? [found[nowIndex]] : [])));
      }
    };
    const attach = (win: Window) => {
      const doc = win.document;
      if ((doc as any).__librarium) return;
      (doc as any).__librarium = true;
      const style = doc.createElementNS(doc.documentElement.namespaceURI ?? "http://www.w3.org/1999/xhtml", "style");
      style.textContent = HIGHLIGHT_CSS;
      (doc.head ?? doc.documentElement).appendChild(style);
      const fire = () => setTimeout(() => watchers.forEach((w) => w()), 0);
      doc.addEventListener("mouseup", () => {
        setTimeout(() => snapToWords(doc.getSelection()), 0);
        fire();
      });
      doc.addEventListener("keyup", (e) => e.shiftKey && fire());
      doc.addEventListener("selectionchange", () => {
        if (!doc.getSelection()?.toString().trim()) fire();
      });
      doc.addEventListener("keydown", onKey);
      doc.addEventListener("wheel", onWheel, { passive: true });
      doc.addEventListener("mousedown", () => closePopover());
      doc.addEventListener("mousemove", (e) => {
        const f = frames().find((x) => x.doc === doc);
        const b = f?.el.getBoundingClientRect();
        if (b) pointerWatchers.forEach((cb) => cb({ x: b.left + e.clientX, y: b.top + e.clientY }));
        stirred();
      });
      doc.addEventListener("click", (e) => {
        if (doc.getSelection()?.toString().trim()) return;
        const at = (doc as any).caretRangeFromPoint?.(e.clientX, e.clientY) as Range | null;
        if (!at) return;
        const f = frames().find((x) => x.doc === doc);
        if (!f) return;
        const ids = marks.filter((m) => m.saved && m.cfi).filter((m) => {
          const r = resolveCFI(m.cfi!);
          if (!r || r.index !== f.index) return false;
          try {
            return r.range(doc).isPointInRange(at.startContainer, at.startOffset);
          } catch {
            return false;
          }
        }).map((m) => m.id);
        if (!ids.length) return;
        const b = f.el.getBoundingClientRect();
        markClickers.forEach((cb) => cb(ids, { x: b.left + e.clientX, y: b.top + e.clientY }));
      });
      draw();
    };

    const listeners: Partial<EpubNavigatorListeners> = {
      frameLoaded: (win) => attach(win),
      positionChanged: (loc) => {
        current = loc;
        head.textContent = tocFor(loc)?.title ?? loc.title ?? book.title;
        pct.textContent = loc.locations.totalProgression !== undefined ? `${Math.round(loc.locations.totalProgression * 100)}%` : "";
        setTimeout(showLeft, 60);
        if (!painted) {
          painted = true;
          events.firstPaint(performance.now() - t0);
        }
        for (const f of frames()) attach(f.win);
        draw();
        events.moved();
        clearTimeout(saveTimer);
        saveTimer = setTimeout(() => store?.set(PLACE(src.id), loc.serialize()), 800);
      },
      textSelected: () => watchers.forEach((w) => w()),
      // Links out of the book: the app asks before opening them in the browser.
      handleLocator: (loc) => {
        if (/^https?:|^mailto:/i.test(loc.href)) document.dispatchEvent(new CustomEvent("open-link", { detail: { url: loc.href, text: loc.title ?? "" } }));
        return true;
      },
    };
    const saved = store?.get(PLACE(src.id));
    const initial = saved ? Locator.deserialize(saved) : undefined;
    const nav = new EpubNavigator(stage, book.publication, listeners as EpubNavigatorListeners, book.positions, initial, { preferences: toPreferences(settings), defaults: {} });
    await nav.load();

    // Moving.
    const done = () => {};
    function turn(dir: 1 | -1) {
      if (dir > 0) nav.goForward(false, done);
      else nav.goBackward(false, done);
    }
    function goHref(href: string) {
      const link = new Link({ href: href.split("#")[0]!.split("/").map(encodeURIComponent).join("/") + (href.includes("#") ? `#${href.split("#")[1]}` : "") });
      nav.goLink(link, false, done);
    }
    function onKey(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return;
      const t = e.target as HTMLElement | null;
      if (t?.closest?.("select, input, textarea, button, [contenteditable=true]")) return;
      const go =
        e.key === "ArrowRight" ? () => nav.goRight(false, done)
        : e.key === "ArrowLeft" ? () => nav.goLeft(false, done)
        : e.key === "PageDown" || (e.key === " " && !e.shiftKey) ? () => turn(1)
        : e.key === "PageUp" || (e.key === " " && e.shiftKey) ? () => turn(-1)
        : null;
      if (!go) return;
      e.preventDefault();
      go();
    }
    frame.addEventListener("keydown", onKey);

    // Pages left in this chapter, from the layout (columns across the frame), as Books says it.
    function showLeft() {
      left.textContent = "";
      if (settings.scroll || book.fixed || !current) return;
      const path = decodeURIComponent(current.href.split("#")[0]!);
      const f = frames().find((x) => x.index >= 0 && book.spine[x.index]!.href === path && x.el.style.visibility !== "hidden");
      const w = f?.el.clientWidth ?? 0;
      if (!f || !w) return;
      const el = f.doc.scrollingElement ?? f.doc.documentElement;
      const total = Math.max(1, Math.round(el.scrollWidth / w));
      const at = Math.min(total - 1, el.scrollLeft > 0 ? Math.round(el.scrollLeft / w) : Math.round((current.locations.progression ?? 0) * total));
      const n = total - 1 - at;
      left.textContent = n === 0 ? "Last page in chapter" : n === 1 ? "1 page left in chapter" : `${n} pages left in chapter`;
    }
    // The page's colour reaches the edges, as in Books (head, foot and margins share it).
    function paintChrome() {
      const t = THEMES[themeOf(settings)];
      frame.style.setProperty("--book-bg", t.backgroundColor);
      frame.style.setProperty("--book-muted", `color-mix(in srgb, ${t.textColor} 55%, transparent)`);
    }
    paintChrome();
    const resized = new ResizeObserver(() => showLeft());
    resized.observe(stage);

    // The arrows show while the pointer moves, then fade.
    let stillTimer: ReturnType<typeof setTimeout> | undefined;
    function stirred() {
      frame.classList.add("stirred");
      clearTimeout(stillTimer);
      stillTimer = setTimeout(() => frame.classList.remove("stirred"), 1800);
    }
    frame.addEventListener("mousemove", stirred);
    // A trackpad swipe turns one page per gesture (in pages, not when scrolling).
    let swipe = 0;
    let swiped = false;
    let swipeTimer: ReturnType<typeof setTimeout> | undefined;
    function onWheel(e: WheelEvent) {
      if (settings.scroll || Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return;
      clearTimeout(swipeTimer);
      swipeTimer = setTimeout(() => {
        swipe = 0;
        swiped = false;
      }, 250);
      if (swiped) return;
      swipe += e.deltaX;
      if (Math.abs(swipe) < 40) return;
      swiped = true;
      if (swipe > 0) nav.goRight(false, done);
      else nav.goLeft(false, done);
    }
    frame.addEventListener("wheel", onWheel, { passive: true });

    // Popovers from the toolbar: the contents, and the Aa panel.
    let popover: { kind: "contents" | "settings"; el: HTMLElement; anchor: HTMLElement } | null = null;
    const apply = (next: ReadingSettings) => {
      settings = next;
      store?.set("reader.epub", settings);
      paintChrome();
      void nav.submitPreferences(new EpubPreferences(toPreferences(settings))).then(() => setTimeout(showLeft, 120));
    };
    function closePopover() {
      if (!popover) return;
      popover.el.remove();
      popover.anchor.setAttribute("aria-expanded", "false");
      popover = null;
      chromeWatchers.forEach((cb) => cb(false));
    }
    function togglePopover(kind: "contents" | "settings") {
      const was = popover?.kind;
      closePopover();
      if (was === kind) return;
      const anchor = kind === "contents" ? contentsBtn : aa;
      const el = kind === "contents" ? contentsList() : settingsPanel(settings, apply, closePopover, book.fixed);
      document.body.appendChild(el);
      const r = anchor.getBoundingClientRect();
      el.style.top = `${Math.round(r.bottom + 6)}px`;
      if (kind === "contents") el.style.left = `${Math.max(8, Math.round(r.left))}px`;
      else el.style.right = `${Math.max(8, Math.round(window.innerWidth - r.right))}px`;
      popover = { kind, el, anchor };
      anchor.setAttribute("aria-expanded", "true");
      chromeWatchers.forEach((cb) => cb(true));
      (el.querySelector<HTMLElement>("[aria-current=true]") ?? el.querySelector<HTMLElement>("button"))?.focus();
    }
    function contentsList(): HTMLElement {
      const here = current ? tocFor(current)?.href : undefined;
      const el = h("div", { class: "epub-popover epub-toc", role: "dialog", "aria-label": "Contents" },
        h("div", { class: "epub-toc-title" }, book.title),
        h("ul", { class: "epub-toc-list" }, book.toc.map((t) => h("li", null, h("button", { type: "button", class: "epub-toc-item", style: `padding-left: ${12 + t.depth * 16}px`, "aria-current": t.href === here ? "true" : undefined, onclick: () => (closePopover(), goHref(t.href)) }, t.title)))));
      el.addEventListener("keydown", (e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          closePopover();
          contentsBtn.focus();
        } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          const items = [...el.querySelectorAll<HTMLElement>(".epub-toc-item")];
          const i = items.indexOf(document.activeElement as HTMLElement);
          items[Math.max(0, Math.min(items.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)))]?.focus();
          e.preventDefault();
        }
      });
      return el;
    }
    const onAway = (e: MouseEvent) => {
      if (popover && !popover.el.contains(e.target as Node) && !popover.anchor.contains(e.target as Node)) closePopover();
    };
    window.addEventListener("mousedown", onAway, true);
    // "Follow the app" follows the app's theme as it changes.
    const themeWatch = new MutationObserver(() => settings.matchApp && apply(settings));
    themeWatch.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    const media = window.matchMedia?.("(prefers-color-scheme: dark)");
    const onScheme = () => settings.matchApp && apply(settings);
    media?.addEventListener?.("change", onScheme);

    const view: ReaderView = {
      immersive: true,
      controls: { start: [contentsBtn], end: [aa] },
      onPointer(cb) {
        pointerWatchers.add(cb);
        return () => pointerWatchers.delete(cb);
      },
      onChromeWanted(cb) {
        chromeWatchers.add(cb);
        return () => chromeWatchers.delete(cb);
      },
      zoomIn: () => apply({ ...settings, fontSize: Math.min(2.5, round(settings.fontSize + 0.1)) }),
      zoomOut: () => apply({ ...settings, fontSize: Math.max(0.6, round(settings.fontSize - 0.1)) }),
      zoomReset: () => apply({ ...settings, fontSize: 1 }),
      async find(query, opts = {}) {
        if (!query.trim()) {
          view.findClear();
          return { count: 0, current: 0 };
        }
        if (!opts.again || findState?.query !== query) {
          const results: Found[] = [];
          for (const s of book.spine) {
            if (!s.linear) continue;
            const text = await book.chapterText(s.href);
            const re = queryPattern(query);
            let m: RegExpExecArray | null;
            let nth = 0;
            while ((m = re.exec(text))) {
              results.push({ path: s.href, type: s.type, nth: nth++, before: text.slice(Math.max(0, m.index - 40), m.index), highlight: m[0], after: text.slice(m.index + m[0].length, m.index + m[0].length + 40) });
              if (!m[0].length) re.lastIndex++;
            }
          }
          findState = { query, results, at: -1 };
        }
        const st = findState!;
        if (!st.results.length) {
          draw();
          return { count: 0, current: 0 };
        }
        st.at = opts.back ? (st.at - 1 + st.results.length) % st.results.length : (st.at + 1) % st.results.length;
        const r = st.results[st.at]!;
        await go(new Locator({ href: hrefOf(r.path), type: r.type, locations: new LocatorLocations({}), text: new LocatorText({ before: r.before, highlight: r.highlight, after: r.after }) }));
        draw();
        return { count: st.results.length, current: st.at + 1 };
      },
      findClear() {
        findState = null;
        draw();
      },
      position: () => describe(current),
      selection() {
        for (const f of frames()) {
          const sel = f.doc.getSelection();
          const text = sel?.toString().trim();
          if (!sel || !text || !sel.rangeCount || f.index < 0) continue;
          const range = sel.getRangeAt(0);
          const cfi = CFI.joinIndir(book.spine[f.index]!.cfi, CFI.fromRange(range));
          const b = f.el.getBoundingClientRect();
          const e = endOf(range);
          return { text, chapter: f.index, cfi, end: e ? { x: e.x + b.left, y: e.y + b.top, bottom: e.bottom + b.top } : undefined };
        }
        return null;
      },
      watchSelection(cb) {
        watchers.add(cb);
        return () => watchers.delete(cb);
      },
      clearSelection() {
        for (const f of frames()) f.doc.getSelection()?.removeAllRanges();
      },
      setMarks(m) {
        marks = m.filter((x) => x.cfi);
        draw();
      },
      onMarkClick(cb) {
        markClickers.add(cb);
        return () => markClickers.delete(cb);
      },
      async showPlace(selectors) {
        const cfi = selectors.find((s) => s.type === "FragmentSelector" && (s.value ?? "").startsWith("epubcfi("))?.value;
        const quote = selectors.find((s) => s.type === "TextQuoteSelector") as { exact?: string; prefix?: string; suffix?: string } | undefined;
        const spot = cfi ? resolveCFI(cfi) : null;
        const item = spot && spot.index >= 0 ? book.spine[spot.index] : undefined;
        if (!item) return false;
        const exact = quote?.exact?.replace(/\s+/g, " ").trim();
        await go(new Locator({ href: hrefOf(item.href), type: item.type, locations: new LocatorLocations({}), ...(exact ? { text: new LocatorText({ highlight: exact.slice(0, 300), before: quote?.prefix?.slice(-40), after: quote?.suffix?.slice(0, 40) }) } : {}) }));
        draw();
        return true;
      },
      destroy() {
        clearTimeout(saveTimer);
        if (current) store?.set(PLACE(src.id), current.serialize());
        themeWatch.disconnect();
        resized.disconnect();
        closePopover();
        window.removeEventListener("mousedown", onAway, true);
        clearTimeout(stillTimer);
        clearTimeout(swipeTimer);
        media?.removeEventListener?.("change", onScheme);
        void nav.destroy();
        book.close();
        frame.remove();
      },
    };
    function go(loc: Locator): Promise<boolean> {
      return new Promise((res) => nav.go(loc, false, (ok) => res(ok)));
    }
    return view;
  },
};

interface Found {
  path: string;
  type: string;
  nth: number;
  before: string;
  highlight: string;
  after: string;
}

const round = (n: number) => Math.round(n * 100) / 100;
const hrefOf = (path: string) => path.split("/").map(encodeURIComponent).join("/");

/** The last step's index of a CFI (`epubcfi(/6/4[id])` → 4). */
function lastStep(cfi: string): number | undefined {
  try {
    const parts = CFI.parse(cfi);
    const top = (parts.parent ?? parts)[0];
    return top?.at(-1)?.index;
  } catch {
    return undefined;
  }
}

/** A query as a pattern: case-insensitive, any run of spaces matching any whitespace. */
function queryPattern(q: string): RegExp {
  const esc = q.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
  return new RegExp(esc, "giu");
}

/** Ranges of a query's matches in a page's text (not in scripts or styles), in order. */
function findInDoc(doc: Document, query: string): Range[] {
  const root = doc.body ?? doc.documentElement;
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement?.closest("script, style, head") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  const nodes: Text[] = [];
  const starts: number[] = [];
  let text = "";
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    nodes.push(n as Text);
    starts.push(text.length);
    text += (n as Text).data;
  }
  const at = (offset: number): [Text, number] => {
    let lo = 0;
    let hi = nodes.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid]! <= offset) lo = mid;
      else hi = mid - 1;
    }
    return [nodes[lo]!, offset - starts[lo]!];
  };
  const out: Range[] = [];
  if (!nodes.length) return out;
  const re = queryPattern(query);
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (!m[0].length) {
      re.lastIndex++;
      continue;
    }
    const r = doc.createRange();
    const [sn, so] = at(m.index);
    const [en, eo] = at(m.index + m[0].length);
    r.setStart(sn, so);
    r.setEnd(en, eo);
    out.push(r);
  }
  return out;
}

const HIGHLIGHT_CSS = `
::highlight(lib-saved) { background-color: rgb(255 196 0 / 30%); }
::highlight(lib-pending) { background-color: rgb(255 196 0 / 55%); }
::highlight(lib-find) { background-color: rgb(255 200 0 / 40%); }
::highlight(lib-find-now) { background-color: rgb(255 130 0 / 60%); }
`;

/* eslint-enable @typescript-eslint/no-explicit-any */
