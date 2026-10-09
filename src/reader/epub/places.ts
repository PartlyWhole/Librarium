/**
 * Places in a book: what is drawn in its pages (captures, find hits, a place being shown), the
 * EPUB CFIs captures store, going to a CFI, a quote or a search offset, find across the whole
 * book, and the first words on screen (kept when the layout changes).
 */
import type { EpubNavigator } from "@readium/navigator";
import { Locator, LocatorLocations, LocatorText } from "@readium/shared";
import * as CFI from "../../../vendor/foliate-js/epubcfi.js";
import { endOf } from "../marks";
import { pageAtOffset, type Extracted, type Mark, type ReaderSelection } from "../types";
import { findInDoc, laidOut, onScreenX, onScreenY, queryPattern, zoomOf } from "./pages";
import type { Book } from "./streamer";

/* eslint-disable @typescript-eslint/no-explicit-any -- the CSS Custom Highlight API isn't typed here */

/** A page of the book on screen: its window, document, frame and spine index. */
export interface Frame {
  win: Window;
  doc: Document;
  el: HTMLIFrameElement;
  index: number;
}

/** The open book as the parts of the reader share it. */
export interface BookView {
  book: Book;
  /** The navigator (made after the parts that use it, so read when needed). */
  nav(): EpubNavigator;
  stage: HTMLElement;
  frames(): Frame[];
  /** The page of a chapter shown on screen. */
  visible(path: string): Frame | undefined;
  current(): Locator | undefined;
  scrolling(): boolean;
  /** Resolves once the first page is shown and laid out. */
  settled(): Promise<void>;
}

interface Found {
  path: string;
  type: string;
  nth: number;
  before: string;
  highlight: string;
  after: string;
}

export const hrefOf = (path: string) => path.split("/").map(encodeURIComponent).join("/");
export const pathOf = (loc: Locator) => decodeURIComponent(loc.href.split("#")[0]!);

export type Places = ReturnType<typeof bookPlaces>;

export function bookPlaces(b: BookView, text: () => Promise<Extracted | null>) {
  const { book, stage } = b;
  let marks: Mark[] = [];
  let findState: { query: string; results: Found[]; at: number } | null = null;
  let shown: { index: number; range: Range } | null = null;

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
    for (const f of b.frames()) {
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

  /** The saved marks under a point of a page (its caret there). */
  const marksAt = (f: Frame, at: Range): string[] =>
    marks.filter((m) => {
      const r = m.saved && m.cfi ? resolveCFI(m.cfi) : null;
      if (!r || r.index !== f.index) return false;
      try {
        return r.range(f.doc).isPointInRange(at.startContainer, at.startOffset);
      } catch {
        return false;
      }
    }).map((m) => m.id);

  /** A range in a page: its text, chapter and CFI (as captures store it), and where it ends. */
  function selOf(f: Frame, range: Range): ReaderSelection & { cfi: string } {
    const cfi = CFI.joinIndir(book.spine[f.index]!.cfi, CFI.fromRange(range));
    const r = f.el.getBoundingClientRect();
    const e = endOf(range);
    const sy = (y: number) => onScreenY(f.doc, y) + r.top;
    return { text: range.toString().trim(), chapter: f.index, cfi, end: e ? { x: onScreenX(f.doc, e.x) + r.left, y: sy(e.y), bottom: sy(e.bottom) } : undefined };
  }
  /** A range's boxes on screen (window coordinates). */
  function screenRects(f: { doc: Document; el: HTMLIFrameElement }, range: Range): DOMRect[] {
    const r = f.el.getBoundingClientRect();
    const z = zoomOf(f.doc);
    return [...range.getClientRects()].map((x) => new DOMRect(r.left + onScreenX(f.doc, x.left), r.top + onScreenY(f.doc, x.top), x.width * z, x.height * z));
  }
  const go = (loc: Locator) => new Promise<boolean>((res) => b.nav().go(loc, false, (ok) => res(ok)));
  const locatorIn = (path: string, locations: ConstructorParameters<typeof LocatorLocations>[0], text?: ConstructorParameters<typeof LocatorText>[0]) =>
    new Locator({ href: hrefOf(path), type: book.spine.find((x) => x.href === path)?.type ?? "application/xhtml+xml", locations: new LocatorLocations(locations), ...(text ? { text: new LocatorText(text) } : {}) });
  /**
   * Shows the page with a range on it: goes to its chapter, finds the range (`pick`) and moves
   * to where it starts. Readium's own text search is only a fallback: when it misses, it lands
   * elsewhere in the chapter. Returns the range shown.
   */
  async function showRange(path: string, pick: (doc: Document) => Range | null): Promise<Range | null> {
    if (!book.spine.some((x) => x.href === path)) return null;
    await b.settled();
    const current = b.current();
    const inChapter = current && pathOf(current) === path;
    if (!inChapter || !b.visible(path)) await go(locatorIn(path, { progression: 0 }));
    let f = b.visible(path);
    for (let i = 0; !f && i < 40; i++) {
      await new Promise((r) => setTimeout(r, 50));
      f = b.visible(path);
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
    const s = stage.getBoundingClientRect();
    return !!r && r.left >= s.left - 1 && r.left < s.right && r.top >= s.top - 1 && r.top < s.bottom;
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
    if (b.scrolling()) {
      const room = el.scrollHeight - el.clientHeight;
      return room > 0 ? Math.min(1, Math.max(0, ((rect.top + el.scrollTop) * z - 24) / el.scrollHeight)) : 0;
    }
    const page = el.clientWidth;
    const room = el.scrollWidth - page;
    if (room <= 0 || page <= 0) return 0;
    const at = Math.floor(((rect.left + el.scrollLeft) * z) / page) * page;
    return Math.min(1, Math.max(0, (at + 0.5) / room));
  }
  /** The first words on screen, as a CFI. */
  function wordsShown(): string | null {
    const current = b.current();
    if (!current || book.fixed) return null;
    const f = b.visible(pathOf(current));
    if (!f?.doc.body) return null;
    const s = stage.getBoundingClientRect();
    const on = (r: DOMRect) => r.width > 0 && r.right > s.left + 1 && r.left < s.right - 1 && r.bottom > s.top + 1 && r.top < s.bottom - 1;
    const walk = f.doc.createTreeWalker(f.doc.body, NodeFilter.SHOW_TEXT);
    const range = f.doc.createRange();
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      const t = n.nodeValue ?? "";
      if (!t.trim()) continue;
      range.selectNodeContents(n);
      if (!screenRects(f, range).some(on)) continue;
      // The first word of this text on screen (its start may be on the page before).
      for (const m of t.matchAll(/\S+/g)) {
        range.setStart(n, m.index);
        range.setEnd(n, m.index + m[0].length);
        if (screenRects(f, range).some(on)) return selOf(f, range).cfi;
      }
    }
    return null;
  }

  /** Find in the whole book: every chapter's text, searched once per query. */
  async function find(query: string, opts: { again?: boolean; back?: boolean } = {}): Promise<{ count: number; current: number }> {
    if (!query.trim()) {
      findClear();
      return { count: 0, current: 0 };
    }
    if (!opts.again || findState?.query !== query) {
      const results: Found[] = [];
      for (const s of book.spine) {
        if (!s.linear) continue;
        const t = await book.chapterText(s.href);
        const re = queryPattern(query);
        let nth = 0;
        for (let m = re.exec(t); m; m = re.exec(t)) {
          results.push({ path: s.href, type: s.type, nth: nth++, before: t.slice(Math.max(0, m.index - 40), m.index), highlight: m[0], after: t.slice(m.index + m[0].length, m.index + m[0].length + 40) });
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
  }
  function findClear() {
    findState = null;
    draw();
  }

  /** Shows the place `offset` code points into the stored text (a search hit). */
  function goToTextOffset(offset: number) {
    void text().then(async (t) => {
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
  }

  return {
    resolveCFI,
    draw,
    marksAt,
    setMarks(m: Mark[]) {
      marks = m.filter((x) => x.cfi);
      draw();
    },
    selOf,
    screenRects,
    showCfi,
    wordsShown,
    find,
    findClear,
    goToTextOffset,
  };
}

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
