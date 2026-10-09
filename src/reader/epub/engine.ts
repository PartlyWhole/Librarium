/**
 * Books, with Readium's navigator, in the manner of Apple Books.
 *
 * - The book is served from memory by the streamer, its pages made safe there (safe.ts).
 * - Readium lays it out: pages or scrolling, turns across chapters, the reading settings.
 * - A selection gives the same EPUB CFI as the earlier reader did (spine-item CFIs from the
 *   package document plus the range in the page), so older captures still resolve.
 * - Marks and find are drawn with the CSS Custom Highlight API inside Readium's frames.
 *
 * This file opens the book and wires its pages (selection, keys, swipes, links, pictures);
 * places.ts holds places and find, chrome.ts the settings and popovers, edit.ts the editing of
 * a capture's parts.
 */
import { EpubNavigator, type EpubNavigatorListeners } from "@readium/navigator";
import { Locator, Link } from "@readium/shared";
import { pref } from "../../app/prefs";
import { h } from "../../ui/dom";
import { snapToWords } from "../marks";
import type { Engine, ReaderView } from "../types";
import { bookChrome } from "./chrome";
import { editBookParts } from "./edit";
import { isNoteRef, noteAt, notePopover } from "./notes";
import { HIGHLIGHT_CSS, laidOut, onScreenX, onScreenY, pictureIn, pictureToPng } from "./pages";
import { bookPlaces, hrefOf, pathOf, type BookView, type Frame } from "./places";
import { themeOf, THEMES, toPreferences } from "./settings";
import { openBook } from "./streamer";
import { pageTurner } from "./turns";

/* eslint-disable @typescript-eslint/no-explicit-any -- Readium's frame managers are internal */

const round = (n: number) => Math.round(n * 100) / 100;

export const openEpub: Engine = async (host, src, events) => {
  const t0 = performance.now();
  const book = await openBook(await src.bytes(), src.id);
  const placePref = pref<unknown>(`reader.place.${src.id}`, null);

  // The page under a running head (the chapter), arrows at the sides that show while the
  // pointer moves, and a quiet line under the page. Contents and Aa go in the toolbar.
  const stage = h("div", { class: "epub-stage" });
  const head = h("div", { class: "epub-head", "aria-hidden": "true" });
  const left = h("span");
  const pct = h("span", { class: "epub-pct" });
  const foot = h("div", { class: "epub-foot", "aria-live": "polite" }, h("span"), left, pct);
  const prevBtn = h("button", { class: "epub-arrow prev", type: "button", title: "Previous page (←)", "aria-label": "Previous page", onclick: () => void turner.flip("left") }, "‹");
  const nextBtn = h("button", { class: "epub-arrow next", type: "button", title: "Next page (→)", "aria-label": "Next page", onclick: () => void turner.flip("right") }, "›");
  const frame = h("div", { class: "epub-container", tabindex: "0", "aria-label": `${src.title}, book` }, head, stage, foot, prevBtn, nextBtn);
  host.appendChild(frame);

  // Settled: the first page is shown and its fonts have loaded. Places are measured only then
  // (just after opening, Readium is still going to the remembered page and the layout moves).
  let settledNow: () => void = () => {};
  const firstShown = new Promise<void>((r) => (settledNow = r));
  let settling: Promise<void> | null = null;
  const settled = () =>
    (settling ??= (async () => {
      await firstShown;
      for (const f of frames()) await laidOut(f.doc);
    })());

  let current: Locator | undefined;
  let painted = false;
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  const tocFor = (loc: Locator) => book.toc.find((t) => t.href.split("#")[0] === pathOf(loc));
  const describe = (loc: Locator | undefined) => {
    if (!loc) return "";
    const pos = loc.locations.position;
    if (book.fixed && pos) return `Page ${pos} of ${book.positions.length}`;
    const pc = loc.locations.totalProgression !== undefined ? `${Math.round(loc.locations.totalProgression * 100)}%` : "";
    return [tocFor(loc)?.title ?? loc.title, pc].filter(Boolean).join(" · ");
  };

  const watchers = new Set<() => void>();
  const pointerWatchers = new Set<(at: { x: number; y: number }) => void>();
  // Run when the page shown changes (a turn, a new chapter, a new layout).
  const relayouts = new Set<() => void>();
  const chromeWatchers = new Set<(wanted: boolean) => void>();
  const markClickers = new Set<(ids: string[], at: { x: number; y: number }) => void>();

  const frames = (): Frame[] => {
    const out: Frame[] = [];
    for (const f of ((nav as any)?._cframes ?? []) as any[]) {
      let win: Window | undefined;
      try {
        win = f?.window;
      } catch {
        continue; // a frame being taken down
      }
      const doc = win?.document;
      if (!doc || !f.iframe) continue;
      const path = doc.querySelector("meta[name=librarium-href]")?.getAttribute("content") ?? "";
      out.push({ win: win!, doc, el: f.iframe, index: book.spine.findIndex((s) => s.href === path) });
    }
    return out;
  };
  const visible = (path: string) => frames().find((f) => f.index >= 0 && book.spine[f.index]!.href === path && f.el.style.visibility !== "hidden");

  // `nav` is read by `frames()` (via the listeners) before the constructor returns.
  let nav: EpubNavigator | undefined;
  const b: BookView = { book, nav: () => nav!, stage, frames, visible, current: () => current, scrolling: () => chrome.settings().layout === "scroll", settled };
  const places = bookPlaces(b, () => src.text());
  const chrome = bookChrome(b, places, { frame, left, goHref, chromeWatchers });
  const { draw } = places;

  /** Wires a page as it loads: selection, keys, swipes, links, pictures, mark clicks. */
  const attach = (win: Window) => {
    const doc = win.document;
    if ((doc as any).__librarium) return;
    (doc as any).__librarium = true;
    const style = doc.createElementNS(doc.documentElement.namespaceURI ?? "http://www.w3.org/1999/xhtml", "style");
    style.textContent = HIGHLIGHT_CSS;
    (doc.head ?? doc.documentElement).appendChild(style);
    const fire = () => setTimeout(() => watchers.forEach((w) => w()), 0);
    const frameOf = () => frames().find((x) => x.doc === doc);
    doc.addEventListener("mouseup", () => {
      setTimeout(() => snapToWords(doc.getSelection()), 0);
      fire();
    });
    doc.addEventListener("keyup", (e) => e.shiftKey && fire());
    doc.addEventListener("selectionchange", () => !doc.getSelection()?.toString().trim() && fire());
    doc.addEventListener("keydown", onKey);
    doc.addEventListener("wheel", turner.onWheel, { passive: false });
    doc.addEventListener("mousedown", () => chrome.closePopover());
    // Links are followed here, when the pointer is let go within a few pixels of where it was
    // pressed. Readium drops a click whose pointer moved more than a pixel, and a click let go
    // just off a small footnote number is the paragraph's; a drag that selected isn't followed.
    let down: { x: number; y: number; link: HTMLAnchorElement | null } | null = null;
    const linkOf = (t: EventTarget | null) => (t as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
    const still = (e: MouseEvent) => !down || Math.hypot(e.clientX - down.x, e.clientY - down.y) < 8;
    const clickedLink = (e: MouseEvent) => linkOf(e.target) ?? (still(e) ? (down?.link ?? null) : null);
    doc.addEventListener("pointerdown", (e) => void (down = { x: e.clientX, y: e.clientY, link: e.button === 0 ? linkOf(e.target) : null }), true);
    // Not to Readium as well (it would follow the link a second time).
    doc.addEventListener("pointerup", (e) => clickedLink(e) && still(e) && e.stopImmediatePropagation(), true);
    doc.addEventListener("click", (e) => {
      const a = clickedLink(e);
      if (!a || e.button !== 0) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (still(e) && doc.getSelection()?.isCollapsed !== false) follow(a, doc);
    }, true);
    doc.addEventListener("mousemove", (e) => {
      const r = frameOf()?.el.getBoundingClientRect();
      if (r) pointerWatchers.forEach((cb) => cb({ x: r.left + e.clientX, y: r.top + e.clientY }));
      chrome.stirred();
    });
    doc.addEventListener("click", (e) => {
      // A click on a picture selects it, so it can be captured like a passage.
      const pic = (e.target as Element | null)?.closest?.("img, svg image");
      if (pic && !doc.getSelection()?.toString().trim()) {
        const r = doc.createRange();
        r.selectNode(pic.closest("svg") ?? pic);
        doc.getSelection()?.removeAllRanges();
        doc.getSelection()?.addRange(r);
        fire();
        return;
      }
      if (doc.getSelection()?.toString().trim()) return;
      const at = (doc as any).caretRangeFromPoint?.(e.clientX, e.clientY) as Range | null;
      const f = frameOf();
      if (!at || !f) return;
      const ids = places.marksAt(f, at);
      if (!ids.length) return;
      const r = f.el.getBoundingClientRect();
      markClickers.forEach((cb) => cb(ids, { x: r.left + e.clientX, y: r.top + e.clientY }));
    });
    draw();
  };

  const listeners: Partial<EpubNavigatorListeners> = {
    frameLoaded: (win) => attach(win),
    positionChanged: (loc) => {
      current = loc;
      head.textContent = tocFor(loc)?.title ?? loc.title ?? book.title;
      pct.textContent = loc.locations.totalProgression !== undefined ? `${Math.round(loc.locations.totalProgression * 100)}%` : "";
      setTimeout(chrome.showLeft, 60);
      if (!painted) {
        painted = true;
        events.firstPaint(performance.now() - t0);
        settledNow();
      }
      for (const f of frames()) attach(f.win);
      draw();
      relayouts.forEach((r) => r());
      events.moved();
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => placePref.set(loc.serialize()), 800);
    },
    textSelected: () => watchers.forEach((w) => w()),
    // Clicks and taps never turn pages (only the arrows, keys and swipes do).
    click: () => true,
    tap: () => true,
    // Links out of the book: the app asks before opening them in the browser.
    handleLocator: (loc) => {
      if (/^https?:|^mailto:/i.test(loc.href)) document.dispatchEvent(new CustomEvent("open-link", { detail: { url: loc.href, text: loc.title ?? "" } }));
      return true;
    },
  };
  const savedPlace = placePref.peek();
  const initial = savedPlace ? Locator.deserialize(savedPlace) : undefined;
  nav = new EpubNavigator(stage, book.publication, listeners as EpubNavigatorListeners, book.positions, initial, { preferences: toPreferences(chrome.settings()), defaults: {} });
  const navi = nav;
  const turner = pageTurner(stage, (side) => new Promise<void>((res) => (side === "right" ? navi.goRight(false, () => res()) : navi.goLeft(false, () => res()))), () => current?.locations.position ?? current?.locations.totalProgression, b.scrolling);
  await navi.load();

  const turn = (dir: 1 | -1) => void turner.flip(dir > 0 === (navi.readingProgression !== "rtl") ? "right" : "left");
  function onKey(e: KeyboardEvent) {
    if (e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return;
    if ((e.target as HTMLElement | null)?.closest?.("select, input, textarea, button, [contenteditable=true]")) return;
    const go =
      e.key === "ArrowRight" ? () => void turner.flip("right")
      : e.key === "ArrowLeft" ? () => void turner.flip("left")
      : e.key === "PageDown" || (e.key === " " && !e.shiftKey) ? () => turn(1)
      : e.key === "PageUp" || (e.key === " " && e.shiftKey) ? () => turn(-1)
      : null;
    if (!go) return;
    e.preventDefault();
    go();
  }
  frame.addEventListener("keydown", onKey);
  frame.addEventListener("wheel", turner.onWheel, { passive: false });

  /** Where a link in the book goes: the web, or a file of the book (and a place in it). */
  function resolveLink(a: HTMLAnchorElement, doc: Document): { web: string } | { path: string; frag: string } | null {
    const raw = (a.getAttribute("href") ?? "").trim();
    if (!raw || /^javascript:/i.test(raw)) return null;
    if (/^(https?:|mailto:|tel:)/i.test(raw)) return { web: raw };
    const f = frames().find((x) => x.doc === doc);
    const here = f && f.index >= 0 ? book.spine[f.index]!.href : current ? pathOf(current) : "";
    try {
      const u = new URL(raw, `https://book.invalid/${hrefOf(here)}`);
      if (u.hostname !== "book.invalid") return null;
      return { path: decodeURIComponent(u.pathname.slice(1)), frag: decodeURIComponent(u.hash.slice(1)) };
    } catch {
      return null;
    }
  }
  /** Follows a link: to the web (asked first), a note into a popover, anything else to its place. */
  function follow(a: HTMLAnchorElement, doc: Document) {
    const to = resolveLink(a, doc);
    if (!to) return;
    if ("web" in to) return void document.dispatchEvent(new CustomEvent("open-link", { detail: { url: to.web, text: a.textContent ?? "" } }));
    const go = () => goHref(to.frag ? `${to.path}#${to.frag}` : to.path);
    if (!to.frag || !isNoteRef(a)) return go();
    void noteTarget(to.path, to.frag).then((t) => {
      const note = noteAt(t, a);
      if (!note) return go();
      chrome.closePopover();
      const fb = frames().find((x) => x.doc === doc)?.el.getBoundingClientRect() ?? new DOMRect();
      const r = a.getBoundingClientRect();
      const theme = THEMES[themeOf(chrome.settings())];
      chrome.showNote(notePopover(note, new DOMRect(fb.left + r.left, fb.top + r.top, r.width, r.height), { bg: theme.backgroundColor, text: theme.textColor }, () => (chrome.closePopover(), frame.focus()), go));
    }, go);
  }
  /** The element a note link targets: in the page shown, else in its file. */
  async function noteTarget(path: string, frag: string): Promise<Element | null> {
    const inPage = visible(path)?.doc.getElementById(frag);
    if (inPage) return inPage;
    const href = hrefOf(path);
    const link = book.publication.readingOrder.findWithHref(href) ?? book.publication.resources?.findWithHref(href);
    if (!link) return null;
    const d = (await book.publication.get(link).readAsXML()) as Document | undefined;
    return d?.getElementById(frag) ?? null;
  }
  function goHref(href: string) {
    const [path, frag] = href.split("#");
    navi.goLink(new Link({ href: hrefOf(path!) + (frag !== undefined ? `#${frag}` : "") }), false, () => {});
  }

  const view: ReaderView = {
    immersive: true,
    controls: { start: [chrome.contentsBtn], end: [chrome.aa] },
    onPointer(cb) {
      pointerWatchers.add(cb);
      return () => pointerWatchers.delete(cb);
    },
    onChromeWanted(cb) {
      chromeWatchers.add(cb);
      return () => chromeWatchers.delete(cb);
    },
    zoomIn: () => chrome.apply({ ...chrome.settings(), fontSize: Math.min(2.5, round(chrome.settings().fontSize + 0.1)) }),
    zoomOut: () => chrome.apply({ ...chrome.settings(), fontSize: Math.max(0.6, round(chrome.settings().fontSize - 0.1)) }),
    zoomReset: () => chrome.apply({ ...chrome.settings(), fontSize: 1 }),
    layout: book.fixed ? undefined : { get: () => chrome.settings().layout, set: (layout) => chrome.apply({ ...chrome.settings(), layout }) },
    find: places.find,
    findClear: places.findClear,
    goToTextOffset: places.goToTextOffset,
    position: () => describe(current),
    selection() {
      for (const f of frames()) {
        const sel = f.doc.getSelection();
        if (!sel?.rangeCount || f.index < 0) continue;
        const range = sel.getRangeAt(0);
        const text = sel.toString().trim();
        // A picture selected on its own is captured as an image.
        const pic = text ? null : pictureIn(range);
        if (!text && !pic) continue;
        const out = places.selOf(f, range);
        if (!pic) return out;
        const png = pictureToPng(pic);
        if (!png) continue;
        const r = f.el.getBoundingClientRect();
        const pr = pic.getBoundingClientRect();
        return { ...out, text: "", image: png, end: { x: r.left + onScreenX(f.doc, pr.right), y: r.top + onScreenY(f.doc, pr.top), bottom: r.top + onScreenY(f.doc, pr.bottom) } };
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
    setMarks: places.setMarks,
    onMarkClick(cb) {
      markClickers.add(cb);
      return () => markClickers.delete(cb);
    },
    async showPlace(selectors) {
      const cfi = selectors.find((s) => s.type === "FragmentSelector" && (s.value ?? "").startsWith("epubcfi("))?.value;
      return cfi ? places.showCfi(cfi, selectors.find((s) => s.type === "TextQuoteSelector") ?? null, true) : false;
    },
    editParts: (parts, onChange) => editBookParts(b, places, frame, relayouts, parts, onChange),
    destroy() {
      clearTimeout(saveTimer);
      if (current) placePref.set(current.serialize());
      chrome.destroy();
      void navi.destroy();
      book.close();
      frame.remove();
    },
  };
  return view;
};

/* eslint-enable @typescript-eslint/no-explicit-any */
