/**
 * The reader host and its engine registry (slot shell.reader-engines): one engine per format.
 * An engine opens an item into a host element and offers zoom, find and positions.
 */
export interface ReaderSource {
  id: string;
  format: string;
  title: string;
  /** The untouched original's bytes. */
  bytes(): Promise<ArrayBuffer>;
  /** The stored extracted text (JSON), if any. */
  text(): Promise<StoredText | null>;
}

export interface StoredText {
  extractor: string;
  version: number;
  pages?: { page: number; text: string }[];
  chapters?: { href: string; path?: string; title?: string | null; text: string }[];
}

export interface FindResult {
  count: number;
  current: number;
}

export interface ReaderView {
  zoomIn(): void;
  zoomOut(): void;
  zoomReset(): void;
  /** Finds `query`; `again` moves to the next (or, with `back`, the previous) match. */
  find(query: string, opts?: { again?: boolean; back?: boolean }): Promise<FindResult>;
  findClear(): void;
  /** Shows the place `offset` code points into the stored text (from search). */
  goToTextOffset?(offset: number): void;
  /** A short position for the toolbar ("Page 3 of 100"). */
  position(): string;
  /** The user's text selection, with where it is. */
  selection?(): ReaderSelection | null;
  /** Calls `cb` whenever the user finishes making (or clearing) a selection. */
  watchSelection?(cb: () => void): () => void;
  /** Clears the user's text selection. */
  clearSelection?(): void;
  /** Lets the user drag out a region; resolves with it (or null if cancelled). */
  pickRegion?(): Promise<ReaderRegion | null>;
  /** Highlights these places (e.g. the parts of a capture being made), replacing earlier marks. */
  setMarks?(marks: Mark[]): void;
  /** Calls `cb` with the marks clicked on (a plain click, not the end of a selection). */
  onMarkClick?(cb: (ids: string[], at: { x: number; y: number }) => void): () => void;
  /** Shows a place given by W3C selectors (page, quote, region, CFI). */
  showPlace?(selectors: PlaceSelector[]): Promise<boolean>;
  destroy(): void;
}

export interface ReaderSelection {
  text: string;
  /** 1-based page (PDF). */
  page?: number;
  /** Spine index (EPUB). */
  chapter?: number;
  /** EPUB CFI. */
  cfi?: string;
  /** Where the text sits: boxes in percent of their page (or of the image). */
  boxes?: Box[];
  /** The selection's last line on screen (window coordinates), to place controls by it. */
  end?: { x: number; y: number; bottom: number };
}

/** A box in percent of a page (PDF, with its 1-based page) or of an image. */
export interface Box {
  page?: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A highlighted place: text boxes, a region, or (EPUB) a CFI. */
export interface Mark {
  id: string;
  boxes: Box[];
  region?: boolean;
  cfi?: string;
  /** Already saved (drawn softer), rather than part of a capture being made. */
  saved?: boolean;
}

export interface ReaderRegion {
  /** 1-based page (PDF). */
  page?: number;
  /** Percent of the page or image. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** The region as a PNG data URL. */
  png: string;
}

export interface PlaceSelector {
  type: string;
  value?: string;
  exact?: string;
  refinedBy?: PlaceSelector;
}

/** Parses "page=3" (RFC 8118). */
export function pageOf(selectors: PlaceSelector[]): number | null {
  for (const s of selectors) {
    const m = s.type === "FragmentSelector" ? /^page=(\d+)/.exec(s.value ?? "") : null;
    if (m) return Number(m[1]);
  }
  return null;
}

/** Parses "xywh=percent:x,y,w,h" (here or in a refinement). */
export function regionOf(selectors: PlaceSelector[]): { x: number; y: number; w: number; h: number } | null {
  for (const s of selectors) {
    for (const v of [s.value, s.refinedBy?.value]) {
      const m = /^xywh=percent:([\d.]+),([\d.]+),([\d.]+),([\d.]+)/.exec(v ?? "");
      if (m) return { x: Number(m[1]), y: Number(m[2]), w: Number(m[3]), h: Number(m[4]) };
    }
  }
  return null;
}

/**
 * Lets the user drag a rectangle over the visible part of `scroller`; resolves with it in
 * window coordinates, or null on Escape or a click without a drag. The layer covers what is on
 * screen (wherever the document is scrolled to); the wheel still scrolls the document, and the
 * drag follows the mouse even outside the layer.
 */
export function dragRect(scroller: HTMLElement): Promise<DOMRect | null> {
  return new Promise((resolve) => {
    const layer = document.createElement("div");
    layer.className = "region-layer";
    const hint = document.createElement("div");
    hint.className = "region-hint";
    hint.textContent = "Drag over the region to capture. Escape cancels.";
    const box = document.createElement("div");
    box.className = "region-box";
    layer.append(hint, box);
    const place = () => {
      const b = scroller.getBoundingClientRect();
      Object.assign(layer.style, { left: `${b.left}px`, top: `${b.top}px`, width: `${b.width}px`, height: `${b.height}px` });
    };
    place();
    document.body.appendChild(layer);
    let start: { x: number; y: number } | null = null;
    let last: { x: number; y: number } | null = null;
    const draw = () => {
      if (!start || !last) return;
      const b = layer.getBoundingClientRect();
      Object.assign(box.style, { left: `${Math.min(last.x, start.x) - b.left}px`, top: `${Math.min(last.y, start.y) - b.top}px`, width: `${Math.abs(last.x - start.x)}px`, height: `${Math.abs(last.y - start.y)}px`, display: "block" });
    };
    const done = (r: DOMRect | null) => {
      layer.remove();
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("mousemove", onMove, true);
      window.removeEventListener("mouseup", onUp, true);
      window.removeEventListener("resize", place);
      resolve(r);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        done(null);
      }
    };
    const onMove = (e: MouseEvent) => {
      if (!start) return;
      last = { x: e.clientX, y: e.clientY };
      draw();
    };
    const onUp = (e: MouseEvent) => {
      if (!start) return;
      last = { x: e.clientX, y: e.clientY };
      const b = layer.getBoundingClientRect();
      const x = Math.max(b.left, Math.min(start.x, last.x)), y = Math.max(b.top, Math.min(start.y, last.y));
      const r = new DOMRect(x, y, Math.min(b.right, Math.max(start.x, last.x)) - x, Math.min(b.bottom, Math.max(start.y, last.y)) - y);
      done(r.width > 4 && r.height > 4 ? r : null);
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("mousemove", onMove, true);
    window.addEventListener("mouseup", onUp, true);
    window.addEventListener("resize", place);
    layer.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      start = { x: e.clientX, y: e.clientY };
      last = start;
      hint.hidden = true;
      e.preventDefault();
    });
    // Scrolling while picking moves the document under the layer.
    layer.addEventListener("wheel", (e) => {
      scroller.scrollBy({ left: e.deltaX, top: e.deltaY });
      e.preventDefault();
    }, { passive: false });
  });
}

/** An element's box inside its border (where its absolutely placed children go). */
export function innerRect(el: HTMLElement): DOMRect {
  const b = el.getBoundingClientRect();
  return new DOMRect(b.left + el.clientLeft, b.top + el.clientTop, el.clientWidth || b.width, el.clientHeight || b.height);
}

/** The boxes of a range, in percent of `over` (merged per line). */
export function boxesIn(range: Range, over: HTMLElement, page?: number): Box[] {
  const b = innerRect(over);
  if (!b.width || !b.height) return [];
  const pct = (v: number, of: number) => Math.round((v / of) * 10000) / 100;
  // Rectangles on screen, clipped to this element; neighbours on one line join, so a line is
  // one box. "One line" is judged in pixels by how much they overlap vertically: in percent of
  // a very tall page (a saved web page), whole lines are within a fraction of a percent.
  const lines: { l: number; t: number; r: number; b: number }[] = [];
  for (const r of range.getClientRects()) {
    if (r.width < 1 || r.height < 1) continue;
    const l = Math.max(r.left, b.left), t = Math.max(r.top, b.top), rr = Math.min(r.right, b.right), bb = Math.min(r.bottom, b.bottom);
    if (rr <= l || bb <= t) continue;
    const prev = lines[lines.length - 1];
    const overlap = prev ? Math.min(prev.b, bb) - Math.max(prev.t, t) : 0;
    if (prev && overlap > 0.5 * Math.min(prev.b - prev.t, bb - t) && l <= prev.r + 2) {
      prev.l = Math.min(prev.l, l);
      prev.r = Math.max(prev.r, rr);
      prev.t = Math.min(prev.t, t);
      prev.b = Math.max(prev.b, bb);
    } else lines.push({ l, t, r: rr, b: bb });
  }
  return lines.map((x) => ({ ...(page ? { page } : {}), x: pct(x.l - b.left, b.width), y: pct(x.t - b.top, b.height), w: pct(x.r - x.l, b.width), h: pct(x.b - x.t, b.height) }));
}

/**
 * Widens a selection made with the mouse to whole words, as Books and Kindle do: a drag that
 * starts or ends inside a word takes the whole word. Keeps the selection's direction.
 */
export function snapToWords(sel: Selection | null): void {
  if (!sel || sel.rangeCount !== 1 || sel.isCollapsed) return;
  const r = sel.getRangeAt(0);
  const inWord = (c: string | undefined) => !!c && /[\p{L}\p{N}\p{M}'’]/u.test(c);
  let so = r.startOffset;
  let eo = r.endOffset;
  const { startContainer: sc, endContainer: ec } = r;
  if (sc.nodeType === Node.TEXT_NODE) {
    const t = sc.textContent ?? "";
    while (so > 0 && inWord(t[so]) && inWord(t[so - 1])) so--;
  }
  if (ec.nodeType === Node.TEXT_NODE) {
    const t = ec.textContent ?? "";
    while (eo < t.length && inWord(t[eo - 1]) && inWord(t[eo])) eo++;
  }
  if (so === r.startOffset && eo === r.endOffset) return;
  const backward = sel.anchorNode === ec && sel.anchorOffset === r.endOffset && (sel.focusNode !== ec || sel.focusOffset !== r.endOffset);
  if (backward) sel.setBaseAndExtent(ec, eo, sc, so);
  else sel.setBaseAndExtent(sc, so, ec, eo);
}

/** The last line of a selection on screen, to place controls by it. */
export function endOf(range: Range): { x: number; y: number; bottom: number } | undefined {
  const rects = [...range.getClientRects()].filter((r) => r.width > 0);
  const r = rects[rects.length - 1];
  return r ? { x: r.right, y: r.top, bottom: r.bottom } : undefined;
}

/** Draws marks (percent boxes) over an element, replacing the marks drawn there before. */
export function drawMarks(over: HTMLElement, marks: Mark[], page?: number): void {
  over.querySelectorAll(":scope > .pending-mark").forEach((n) => n.remove());
  if (getComputedStyle(over).position === "static") over.style.position = "relative";
  for (const m of marks) {
    for (const b of m.boxes) {
      if (page !== undefined && b.page !== page) continue;
      const el = document.createElement("div");
      el.className = `pending-mark${m.region ? " region" : ""}${m.saved ? " saved" : ""}`;
      el.dataset.mark = m.id;
      Object.assign(el.style, { left: `${b.x}%`, top: `${b.y}%`, width: `${b.w}%`, height: `${b.h}%` });
      over.appendChild(el);
    }
  }
}

/** Crops a region of a canvas or image (in its own pixels) to a PNG data URL. */
export function cropToPng(src: HTMLCanvasElement | HTMLImageElement, sx: number, sy: number, sw: number, sh: number): string {
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(sw));
  c.height = Math.max(1, Math.round(sh));
  c.getContext("2d")!.drawImage(src, sx, sy, sw, sh, 0, 0, c.width, c.height);
  return c.toDataURL("image/png");
}

/** Draws a region outline (percent) over an element. */
export function outlineRegion(over: HTMLElement, r: { x: number; y: number; w: number; h: number }): HTMLElement {
  over.querySelectorAll(".region-mark").forEach((n) => n.remove());
  const mark = document.createElement("div");
  mark.className = "region-mark";
  Object.assign(mark.style, { left: `${r.x}%`, top: `${r.y}%`, width: `${r.w}%`, height: `${r.h}%` });
  if (getComputedStyle(over).position === "static") over.style.position = "relative";
  over.appendChild(mark);
  return mark;
}

export interface ReaderEngine {
  id: string;
  formats: string[];
  open(host: HTMLElement, src: ReaderSource, events: ReaderEvents): Promise<ReaderView>;
}

export interface ReaderEvents {
  /** The position changed (page turned, scrolled). */
  moved(): void;
  /** The first page is on screen (for the 500 ms budget). */
  firstPaint(ms: number): void;
}

/** Which page holds a code-point offset into pages joined by blank lines. */
export function pageAtOffset(pages: { text: string }[], offset: number): number {
  let at = 0;
  for (let i = 0; i < pages.length; i++) {
    const len = [...pages[i]!.text].length + 2;
    if (offset < at + len) return i;
    at += len;
  }
  return Math.max(0, pages.length - 1);
}

/**
 * Reports plain clicks on marks drawn in `over` (marks don't take clicks themselves, so text
 * under them can still be selected): the IDs of the marks under the pointer.
 */
export function watchMarkClicks(over: HTMLElement, cb: (ids: string[], at: { x: number; y: number }) => void): () => void {
  const click = (e: MouseEvent) => {
    if (e.button !== 0 || window.getSelection()?.toString().trim()) return;
    const ids = new Set<string>();
    for (const m of over.querySelectorAll<HTMLElement>(".pending-mark.saved")) {
      const r = m.getBoundingClientRect();
      if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom && m.dataset.mark) ids.add(m.dataset.mark);
    }
    if (ids.size) cb([...ids], { x: e.clientX, y: e.clientY });
  };
  over.addEventListener("click", click);
  return () => over.removeEventListener("click", click);
}
