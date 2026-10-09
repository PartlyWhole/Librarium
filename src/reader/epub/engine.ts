/**
 * Books, with Readium's navigator, in the manner of Apple Books.
 *
 * - The book is served from memory by the streamer, its pages made safe there (safe.ts).
 * - Readium lays it out: pages or scrolling, turns across chapters, the reading settings.
 * - A selection gives the same EPUB CFI as the earlier reader did (spine-item CFIs from the
 *   package document plus the range in the page), so older captures still resolve.
 * - Marks and find are drawn with the CSS Custom Highlight API inside Readium's frames.
 */
import { EpubNavigator, EpubPreferences, type EpubNavigatorListeners } from "@readium/navigator";
import { Locator, LocatorLocations, LocatorText, Link } from "@readium/shared";
import * as CFI from "../../../vendor/foliate-js/epubcfi.js";
import { List } from "lucide";
import { pref } from "../../app/prefs";
import { h } from "../../ui/dom";
import { icon } from "../../ui/icon";
import { caretIn, rangeEditor, type Edges } from "../handles";
import { endOf, snapToWords } from "../marks";
import { pageAtOffset, type Engine, type Mark, type ReaderSelection, type ReaderView } from "../types";
import { isNoteRef, noteAt, notePopover } from "./notes";
import { HIGHLIGHT_CSS, findInDoc, laidOut, onScreenX, onScreenY, pictureIn, pictureToPng, queryPattern, zoomOf } from "./pages";
import { settingsPanel, toPreferences, readSettings, themeOf, THEMES, type ReadingSettings } from "./settings";
import { openBook } from "./streamer";
import { pageTurner } from "./turns";

/* eslint-disable @typescript-eslint/no-explicit-any -- Readium's frame managers are internal */

/** A page of the book on screen: its window, document, frame and spine index. */
interface Frame {
  win: Window;
  doc: Document;
  el: HTMLIFrameElement;
  index: number;
}

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
const pathOf = (loc: Locator) => decodeURIComponent(loc.href.split("#")[0]!);

export const openEpub: Engine = async (host, src, events) => {
  const t0 = performance.now();
  const book = await openBook(await src.bytes(), src.id);
  const settingsPref = pref<unknown>("reader.epub", null);
  const placePref = pref<unknown>(`reader.place.${src.id}`, null);
  let settings = readSettings(settingsPref.peek());
  const scrolling = () => settings.layout === "scroll";

  // The page under a running head (the chapter), arrows at the sides that show while the
  // pointer moves, and a quiet line under the page. Contents and Aa go in the toolbar.
  const stage = h("div", { class: "epub-stage" });
  const head = h("div", { class: "epub-head", "aria-hidden": "true" });
  const left = h("span", { class: "epub-left" });
  const pct = h("span", { class: "epub-pct" });
  const foot = h("div", { class: "epub-foot", "aria-live": "polite" }, h("span"), left, pct);
  const prevBtn = h("button", { class: "epub-arrow prev", type: "button", title: "Previous page (←)", "aria-label": "Previous page", onclick: () => void turner.flip("left") }, "‹");
  const nextBtn = h("button", { class: "epub-arrow next", type: "button", title: "Next page (→)", "aria-label": "Next page", onclick: () => void turner.flip("right") }, "›");
  const frame = h("div", { class: "epub-container", tabindex: "0", "aria-label": `${src.title}, book` }, head, stage, foot, prevBtn, nextBtn);
  host.appendChild(frame);
  const contentsBtn = h("button", { class: "icon-button", type: "button", title: "Contents", "aria-label": "Contents", "aria-expanded": "false", onclick: () => togglePopover("contents") }, icon(List));
  contentsBtn.hidden = !book.toc.length;
  const aa = h("button", { class: "epub-aa", type: "button", title: "Reading settings", "aria-label": "Reading settings", "aria-expanded": "false", onclick: () => togglePopover("settings") }, "Aa");

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
  let marks: Mark[] = [];
  let findState: { query: string; results: Found[]; at: number } | null = null;
  let shown: { index: number; range: Range } | null = null;

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
  const spineSteps = book.spine.map((s) => lastStep(s.cfi));
  const resolveCFI = (cfi: string) => {
    try {
      const parts = CFI.parse(cfi);
      const top = (parts.parent ?? parts).shift();
      return { index: spineSteps.indexOf(top?.at(-1)?.index), range: (doc: Document) => CFI.toRange(doc, parts) as Range };
    } catch {
      return null;
    }
  };

  /** Marks, find hits and a place being shown, in every page on screen. */
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
      reg.set("lib-show", new H(...(shown && shown.index === f.index && shown.range.startContainer.ownerDocument === f.doc ? [shown.range] : [])));
    }
  };

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
    doc.addEventListener("mousedown", () => closePopover());
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
      const b = frameOf()?.el.getBoundingClientRect();
      if (b) pointerWatchers.forEach((cb) => cb({ x: b.left + e.clientX, y: b.top + e.clientY }));
      stirred();
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
      const ids = marks.filter((m) => {
        const r = m.saved && m.cfi ? resolveCFI(m.cfi) : null;
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
  // `nav` is read by `frames()` (via the listeners) before the constructor returns.
  let nav: EpubNavigator | undefined;
  nav = new EpubNavigator(stage, book.publication, listeners as EpubNavigatorListeners, book.positions, initial, { preferences: toPreferences(settings), defaults: {} });
  const navi = nav;
  const turner = pageTurner(stage, (side) => new Promise<void>((res) => (side === "right" ? navi.goRight(false, () => res()) : navi.goLeft(false, () => res()))), () => current?.locations.position ?? current?.locations.totalProgression, scrolling);
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
      closePopover();
      const fb = frames().find((x) => x.doc === doc)?.el.getBoundingClientRect() ?? new DOMRect();
      const r = a.getBoundingClientRect();
      const theme = THEMES[themeOf(settings)];
      const el = notePopover(note, new DOMRect(fb.left + r.left, fb.top + r.top, r.width, r.height), { bg: theme.backgroundColor, text: theme.textColor }, () => (closePopover(), frame.focus()), go);
      popover = { kind: "note", el, anchor: frame };
      chromeWatchers.forEach((cb) => cb(true));
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

  // Pages left in this chapter, from the layout (columns across the frame), as Books says it.
  function showLeft() {
    left.textContent = "";
    if (scrolling() || book.fixed || !current) return;
    const f = visible(pathOf(current));
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
  let resizeTimer: ReturnType<typeof setTimeout> | undefined;
  const resized = new ResizeObserver(() => {
    showLeft();
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => (showLeft(), popover?.el.dispatchEvent(new CustomEvent("laidout", { detail: settings }))), 300);
  });
  resized.observe(stage);
  // The arrows show while the pointer moves, then fade.
  let stillTimer: ReturnType<typeof setTimeout> | undefined;
  function stirred() {
    frame.classList.add("stirred");
    clearTimeout(stillTimer);
    stillTimer = setTimeout(() => frame.classList.remove("stirred"), 1800);
  }
  frame.addEventListener("mousemove", stirred);

  // ---- Popovers from the toolbar: Contents and the Aa panel ----------------------------------
  let popover: { kind: "contents" | "settings" | "note"; el: HTMLElement; anchor: HTMLElement } | null = null;
  const apply = (next: ReadingSettings) => {
    // A new layout keeps the first words on screen (Readium keeps only the chapter's
    // progression, a page or more off between pages and scrolling).
    const keep = next.layout !== settings.layout ? wordsShown() : null;
    settings = next;
    settingsPref.set(settings);
    paintChrome();
    void navi.submitPreferences(new EpubPreferences(toPreferences(settings))).then(async () => {
      if (keep) {
        await new Promise((r) => setTimeout(r, 120));
        await showCfi(keep, null, false);
      }
      setTimeout(() => {
        showLeft();
        popover?.el.dispatchEvent(new CustomEvent("laidout", { detail: settings }));
      }, 120);
    });
  };
  /** The first words on screen, as a CFI. */
  function wordsShown(): string | null {
    if (!current || book.fixed) return null;
    const f = visible(pathOf(current));
    if (!f?.doc.body) return null;
    const b = stage.getBoundingClientRect();
    const on = (r: DOMRect) => r.width > 0 && r.right > b.left + 1 && r.left < b.right - 1 && r.bottom > b.top + 1 && r.top < b.bottom - 1;
    const walk = f.doc.createTreeWalker(f.doc.body, NodeFilter.SHOW_TEXT);
    const range = f.doc.createRange();
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      const text = n.nodeValue ?? "";
      if (!text.trim()) continue;
      range.selectNodeContents(n);
      if (!screenRects(f, range).some(on)) continue;
      // The first word of this text on screen (its start may be on the page before).
      for (const m of text.matchAll(/\S+/g)) {
        range.setStart(n, m.index);
        range.setEnd(n, m.index + m[0].length);
        if (screenRects(f, range).some(on)) return selOf(f, range).cfi;
      }
    }
    return null;
  }
  /** How many pages are side by side now (1 or 2), or null when scrolling. */
  function pagesShown(): number | null {
    if (scrolling() || book.fixed) return null;
    const f = frames().find((x) => x.index >= 0 && x.el.style.visibility !== "hidden");
    const n = f ? Number.parseInt(getComputedStyle(f.doc.documentElement).columnCount, 10) : NaN;
    return Number.isFinite(n) ? n : null;
  }
  function closePopover() {
    if (!popover) return;
    popover.el.remove();
    if (popover.kind !== "note") popover.anchor.setAttribute("aria-expanded", "false");
    popover = null;
    chromeWatchers.forEach((cb) => cb(false));
  }
  function togglePopover(kind: "contents" | "settings") {
    const was = popover?.kind;
    closePopover();
    if (was === kind) return;
    const anchor = kind === "contents" ? contentsBtn : aa;
    const el = kind === "contents" ? contentsList() : settingsPanel(settings, apply, closePopover, book.fixed, pagesShown);
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
  // "Match the app" follows the app's theme as it changes.
  const themeWatch = new MutationObserver(() => settings.matchApp && apply(settings));
  themeWatch.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  const media = window.matchMedia?.("(prefers-color-scheme: dark)");
  const onScheme = () => settings.matchApp && apply(settings);
  media?.addEventListener?.("change", onScheme);

  // ---- Places -----------------------------------------------------------------------------
  /** A range in a page: its text, chapter and CFI (as captures store it), and where it ends. */
  function selOf(f: Frame, range: Range): ReaderSelection & { cfi: string } {
    const cfi = CFI.joinIndir(book.spine[f.index]!.cfi, CFI.fromRange(range));
    const b = f.el.getBoundingClientRect();
    const e = endOf(range);
    const sy = (y: number) => onScreenY(f.doc, y) + b.top;
    return { text: range.toString().trim(), chapter: f.index, cfi, end: e ? { x: onScreenX(f.doc, e.x) + b.left, y: sy(e.y), bottom: sy(e.bottom) } : undefined };
  }
  /** A range's boxes on screen (window coordinates). */
  function screenRects(f: { doc: Document; el: HTMLIFrameElement }, range: Range): DOMRect[] {
    const b = f.el.getBoundingClientRect();
    const z = zoomOf(f.doc);
    return [...range.getClientRects()].map((r) => new DOMRect(b.left + onScreenX(f.doc, r.left), b.top + onScreenY(f.doc, r.top), r.width * z, r.height * z));
  }
  const go = (loc: Locator) => new Promise<boolean>((res) => navi.go(loc, false, (ok) => res(ok)));
  const locatorIn = (path: string, locations: ConstructorParameters<typeof LocatorLocations>[0], text?: ConstructorParameters<typeof LocatorText>[0]) =>
    new Locator({ href: hrefOf(path), type: book.spine.find((x) => x.href === path)?.type ?? "application/xhtml+xml", locations: new LocatorLocations(locations), ...(text ? { text: new LocatorText(text) } : {}) });
  /**
   * Shows the page with a range on it: goes to its chapter, finds the range (`pick`) and moves
   * to where it starts. Readium's own text search is only a fallback: when it misses, it lands
   * elsewhere in the chapter. Returns the range shown.
   */
  async function showRange(path: string, pick: (doc: Document) => Range | null): Promise<Range | null> {
    if (!book.spine.some((x) => x.href === path)) return null;
    await settled();
    const inChapter = current && pathOf(current) === path;
    if (!inChapter || !visible(path)) await go(locatorIn(path, { progression: 0 }));
    let f = visible(path);
    for (let i = 0; !f && i < 40; i++) {
      await new Promise((r) => setTimeout(r, 50));
      f = visible(path);
    }
    if (!f) return null;
    await laidOut(f.doc);
    const range = pick(f.doc);
    if (!range) return null;
    // To its page, then make sure it is on screen (the layout can still move): again if not.
    for (let attempt = 0; attempt < 3; attempt++) {
      const p = progressionOf(f, range);
      if (p > 0) await go(locatorIn(path, { progression: p }));
      await new Promise((r) => setTimeout(r, 60));
      if (onScreen(f, range)) break;
    }
    return range;
  }
  /** Shows a CFI (or the quote in its chapter); brightens it for a moment when `flash`. */
  async function showCfi(cfi: string, quote: { exact?: string; prefix?: string; suffix?: string } | null, flash: boolean): Promise<boolean> {
    const spot = resolveCFI(cfi);
    const item = spot && spot.index >= 0 ? book.spine[spot.index] : undefined;
    if (!spot || !item) return false;
    const exact = quote?.exact?.replace(/\s+/g, " ").trim();
    const range = await showRange(item.href, (doc) => {
      try {
        const r = spot.range(doc);
        if (r.toString().trim()) return r;
      } catch {
        /* not resolvable in this page */
      }
      return exact ? (findInDoc(doc, exact.slice(0, 200))[0] ?? null) : null;
    });
    if (!range) await go(locatorIn(item.href, {}, exact ? { highlight: exact.slice(0, 300), before: quote?.prefix?.slice(-40), after: quote?.suffix?.slice(0, 40) } : undefined));
    else if (flash) brighten(spot.index, range);
    draw();
    return true;
  }
  /** Show: the passage brought out for about two seconds. */
  function brighten(index: number, range: Range) {
    const it = { index, range };
    shown = it;
    draw();
    setTimeout(() => {
      if (shown !== it) return;
      shown = null;
      draw();
    }, 2200);
  }
  /** Whether a range starts on the page shown. */
  function onScreen(f: Frame, range: Range): boolean {
    const r = screenRects(f, range)[0];
    const b = stage.getBoundingClientRect();
    return !!r && r.left >= b.left - 1 && r.left < b.right && r.top >= b.top - 1 && r.top < b.bottom;
  }
  /**
   * Where a range's page starts in its chapter, as Readium counts progression: in pages, the
   * distance scrolled over the distance that can be scrolled (the width less one page);
   * scrolling, over the whole height, 24 pixels above the range.
   */
  function progressionOf(f: Frame, range: Range): number {
    const rect = range.getClientRects()[0] ?? range.getBoundingClientRect();
    const el = f.doc.scrollingElement ?? f.doc.documentElement;
    const z = zoomOf(f.doc);
    if (scrolling()) {
      const room = el.scrollHeight - el.clientHeight;
      return room > 0 ? Math.min(1, Math.max(0, ((rect.top + el.scrollTop) * z - 24) / el.scrollHeight)) : 0;
    }
    const page = el.clientWidth;
    const room = el.scrollWidth - page;
    if (room <= 0 || page <= 0) return 0;
    const at = Math.floor(((rect.left + el.scrollLeft) * z) / page) * page;
    return Math.min(1, Math.max(0, (at + 0.5) / room));
  }
  /**
   * Dragging a passage's end into the book's left or right edge turns the page (after a moment,
   * then again while held), within the chapter: a passage can't span two chapters. Scrolling,
   * the edges are the top and bottom, and the page scrolls.
   */
  function dragEdges(f: Frame): Edges {
    const el = () => f.doc.scrollingElement ?? f.doc.documentElement;
    return {
      bounds: () => stage.getBoundingClientRect(),
      margin: 36,
      delay: scrolling() ? 0 : 450,
      repeat: scrolling() ? 30 : 900,
      armed: (dx) => {
        frame.classList.toggle("armed-next", !scrolling() && dx > 0);
        frame.classList.toggle("armed-prev", !scrolling() && dx < 0);
      },
      nudge: async (dx, dy) => {
        const e = el();
        if (scrolling()) return void (dy && (e.scrollTop += dy * 24));
        if (!dx || (dx > 0 && e.scrollLeft + e.clientWidth >= e.scrollWidth - 2) || (dx < 0 && e.scrollLeft <= 0)) return;
        await new Promise<void>((res) => (dx > 0 ? navi.goRight(false, () => res()) : navi.goLeft(false, () => res())));
        await new Promise((r) => setTimeout(r, 80));
      },
    };
  }

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
    layout: book.fixed ? undefined : { get: () => settings.layout, set: (layout) => apply({ ...settings, layout }) },
    async find(query, opts = {}) {
      if (!query.trim()) {
        view.findClear();
        return { count: 0, current: 0 };
      }
      // The whole book: every chapter's text, searched once per query.
      if (!opts.again || findState?.query !== query) {
        const results: Found[] = [];
        for (const s of book.spine) {
          if (!s.linear) continue;
          const text = await book.chapterText(s.href);
          const re = queryPattern(query);
          let nth = 0;
          for (let m = re.exec(text); m; m = re.exec(text)) {
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
      // If the page's text differs from the chapter's (rare), Readium looks for it.
      if (!(await showRange(r.path, (doc) => findInDoc(doc, st.query)[r.nth] ?? null))) await go(locatorIn(r.path, {}, { before: r.before, highlight: r.highlight, after: r.after }));
      draw();
      return { count: st.results.length, current: st.at + 1 };
    },
    findClear() {
      findState = null;
      draw();
    },
    goToTextOffset(offset) {
      void src.text().then(async (t) => {
        const chapters = t?.chapters ?? [];
        if (!chapters.length) return;
        const i = pageAtOffset(chapters, offset);
        const ch = chapters[i]!;
        const start = chapters.slice(0, i).reduce((n, c) => n + [...c.text].length + 2, 0);
        const path = [ch.path, ch.path && decodeURIComponent(ch.path), ch.href].find((p) => p && book.spine.some((s) => s.href === p));
        if (!path) return;
        // A few words from the place, found in the page (whitespace may differ).
        const words = [...ch.text].slice(Math.max(0, offset - start)).join("").trim().split(/\s+/);
        const pick = (doc: Document) => findInDoc(doc, words.slice(0, 8).join(" "))[0] ?? findInDoc(doc, words.slice(0, 3).join(" "))[0] ?? null;
        const range = await showRange(path, pick);
        if (range) brighten(book.spine.findIndex((s) => s.href === path), range);
      });
    },
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
        const out = selOf(f, range);
        if (!pic) return out;
        const png = pictureToPng(pic);
        if (!png) continue;
        const b = f.el.getBoundingClientRect();
        const pr = pic.getBoundingClientRect();
        return { ...out, text: "", image: png, end: { x: b.left + onScreenX(f.doc, pr.right), y: b.top + onScreenY(f.doc, pr.top), bottom: b.top + onScreenY(f.doc, pr.bottom) } };
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
      return cfi ? showCfi(cfi, selectors.find((s) => s.type === "TextQuoteSelector") ?? null, true) : false;
    },
    editParts(parts, onChange) {
      // Pictures are whole; text parts get handles where they are on the page shown.
      let cur = parts.map((p) => ({ ...p }));
      let editors: { destroy(): void }[] = [];
      let dragging = false;
      const build = () => {
        editors.forEach((e) => e.destroy());
        editors = [];
        for (const p of cur) {
          const spot = !p.region && p.cfi ? resolveCFI(p.cfi) : null;
          const f = spot && frames().find((x) => x.index === spot.index && x.el.style.visibility !== "hidden");
          if (!spot || !f) continue;
          let range: Range;
          try {
            range = spot.range(f.doc);
          } catch {
            continue;
          }
          editors.push(rangeEditor({
            overlay: frame,
            range,
            screenRects: (r) => screenRects(f, r),
            caretAt: (x, y) => {
              const b = f.el.getBoundingClientRect();
              const el = f.doc.scrollingElement ?? f.doc.documentElement;
              const z = zoomOf(f.doc);
              // Window → the page's own measuring units; the browser hit-tests in the frame's pixels.
              const mx = (x - b.left + el.scrollLeft) / z - el.scrollLeft;
              const my = (y - b.top + el.scrollTop) / z - el.scrollTop;
              return f.doc.body ? caretIn(f.doc, f.doc.body, mx, my, { x: x - b.left, y: y - b.top }) : null;
            },
            onDrag: (r) => ((dragging = true), onChange({ key: p.key, done: false, text: selOf(f, r) })),
            onDone: (r) => {
              dragging = false;
              const t = selOf(f, r);
              p.cfi = t.cfi;
              onChange({ key: p.key, done: true, text: t });
            },
            edges: dragEdges(f),
          }));
        }
      };
      const relayout = () => !dragging && build();
      relayouts.add(relayout);
      build();
      return {
        update(next) {
          cur = next.map((p) => ({ ...p }));
          build();
        },
        stop() {
          relayouts.delete(relayout);
          editors.forEach((e) => e.destroy());
          editors = [];
        },
      };
    },
    destroy() {
      clearTimeout(saveTimer);
      clearTimeout(resizeTimer);
      clearTimeout(stillTimer);
      if (current) placePref.set(current.serialize());
      themeWatch.disconnect();
      resized.disconnect();
      closePopover();
      window.removeEventListener("mousedown", onAway, true);
      media?.removeEventListener?.("change", onScheme);
      void navi.destroy();
      book.close();
      frame.remove();
    },
  };
  return view;
};

/** The last step's index of a CFI (`epubcfi(/6/4[id])` → 4). */
function lastStep(cfi: string): number | undefined {
  try {
    const parts = CFI.parse(cfi);
    return (parts.parent ?? parts)[0]?.at(-1)?.index;
  } catch {
    return undefined;
  }
}

/* eslint-enable @typescript-eslint/no-explicit-any */
