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
  /** Per-device storage for reading settings and places (the shell's prefs), if offered. */
  store?: ReaderStore;
}

export interface ReaderStore {
  get(key: string): unknown;
  set(key: string, value: unknown): void;
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
  /**
   * Edits the parts of a capture in place: text parts get handles at their ends to drag, regions
   * a frame to resize and move. `onChange` reports each part as it is dragged (`done` false, to
   * redraw it) and when let go (`done` true, with what to store).
   */
  editParts?(parts: EditPart[], onChange: (p: EditedPart) => void): PartsEditor;
  /**
   * Reading without chrome, as in Apple Books: the toolbar hides until the pointer comes near
   * it (or something in it has focus). Zooming is left to the reader's own controls.
   */
  immersive?: boolean;
  /** The reader's own toolbar controls: `start` go first, `end` before find. */
  controls?: { start?: HTMLElement[]; end?: HTMLElement[] };
  /** Calls `cb` with the pointer's place (window coordinates) as it moves over the reader. */
  onPointer?(cb: (at: { x: number; y: number }) => void): () => void;
  /**
   * Whether the reader wants its chrome kept showing (a popover of its controls is open).
   * The page asks on each change; `onChromeWanted` tells it when the answer changes.
   */
  onChromeWanted?(cb: (wanted: boolean) => void): () => void;
  destroy(): void;
}

/** A part of a capture being edited, as the reader finds it. */
export interface EditPart {
  key: string;
  /** A region part (percent of its page, or of the image). */
  region?: { page?: number; x: number; y: number; w: number; h: number };
  /** A text part: where it was drawn (PDF, images), its CFI (EPUB), its page and quote. */
  boxes?: Box[];
  cfi?: string | null;
  page?: number;
  quote?: string;
}

/** A part as edited: its new text (with where it is) or its new region (with its picture). */
export interface EditedPart {
  key: string;
  done: boolean;
  text?: ReaderSelection;
  region?: ReaderRegion | (Omit<ReaderRegion, "png"> & { png?: undefined });
}

export interface PartsEditor {
  /** The parts changed (one added or removed): edit these. */
  update(parts: EditPart[]): void;
  stop(): void;
}

export interface ReaderSelection {
  text: string;
  /** A picture selected on its own (EPUB): captured as an image, a PNG data URL. */
  image?: string;
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
  /** With type "librarium:boxes": where the place was drawn (percent of its page). */
  boxes?: Box[];
}

/** The box around a place's drawn boxes on one page (the first page they are on). */
export function boxesPlace(selectors: PlaceSelector[]): { page?: number; region: { x: number; y: number; w: number; h: number } } | null {
  const boxes = selectors.find((s) => s.type === "librarium:boxes")?.boxes;
  if (!boxes?.length) return null;
  const page = boxes[0]!.page;
  const on = boxes.filter((b) => b.page === page);
  const x = Math.min(...on.map((b) => b.x));
  const y = Math.min(...on.map((b) => b.y));
  return { page, region: { x, y, w: Math.max(...on.map((b) => b.x + b.w)) - x, h: Math.max(...on.map((b) => b.y + b.h)) - y } };
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

type Edges = { l: number; t: number; r: number; b: number };

/**
 * Whether a rectangle continues the line of the one before (pixels): mostly overlapping
 * vertically, and no further on than a few spaces. A PDF's words are separate spans with gaps
 * between them; a column gap is wider.
 */
function sameLine(prev: Edges, next: Edges): boolean {
  const h = Math.min(prev.b - prev.t, next.b - next.t);
  const overlap = Math.min(prev.b, next.b) - Math.max(prev.t, next.t);
  return overlap > 0.5 * h && next.l <= prev.r + 2.5 * h && next.r >= prev.l - 2;
}

/**
 * Boxes (percent of an element `width` × `height` pixels) joined into one per line, as a
 * selection is drawn. Captures saved before boxes were joined have one box per word.
 */
export function joinLines(boxes: Box[], width: number, height: number): Box[] {
  if (!width || !height) return boxes;
  const out: (Edges & { page?: number })[] = [];
  for (const x of boxes) {
    const r = { l: (x.x * width) / 100, t: (x.y * height) / 100, r: ((x.x + x.w) * width) / 100, b: ((x.y + x.h) * height) / 100 };
    const prev = out[out.length - 1];
    if (prev && prev.page === x.page && sameLine(prev, r)) {
      prev.l = Math.min(prev.l, r.l);
      prev.r = Math.max(prev.r, r.r);
      prev.t = Math.min(prev.t, r.t);
      prev.b = Math.max(prev.b, r.b);
    } else out.push({ ...r, page: x.page });
  }
  return out.map((r) => ({ ...(r.page !== undefined ? { page: r.page } : {}), x: (r.l / width) * 100, y: (r.t / height) * 100, w: ((r.r - r.l) / width) * 100, h: ((r.b - r.t) / height) * 100 }));
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
    if (prev && sameLine(prev, { l, t, r: rr, b: bb })) {
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
  const box = innerRect(over);
  for (const m of marks) {
    const boxes = m.region ? m.boxes : joinLines(m.boxes.filter((b) => page === undefined || b.page === page), box.width, box.height);
    for (const b of boxes) {
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

/**
 * Brings out a passage's place for a moment (its line boxes, percent of `over`): Show lands on
 * the passage itself, as a selection, rather than a frame around it. Returns the first line.
 */
export function flashPlace(over: HTMLElement, boxes: Box[], page?: number): HTMLElement | undefined {
  over.querySelectorAll(".region-mark, .place-mark").forEach((n) => n.remove());
  if (getComputedStyle(over).position === "static") over.style.position = "relative";
  const box = innerRect(over);
  let first: HTMLElement | undefined;
  for (const b of joinLines(boxes.filter((x) => page === undefined || x.page === page), box.width, box.height)) {
    const el = document.createElement("div");
    el.className = "place-mark";
    Object.assign(el.style, { left: `${b.x}%`, top: `${b.y}%`, width: `${b.w}%`, height: `${b.h}%` });
    over.appendChild(el);
    setTimeout(() => el.remove(), 2600);
    first ??= el;
  }
  return first;
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

// ---- Editing a capture's parts in place ------------------------------------------------------

/**
 * A transparent cover over the window while something is dragged: pointer movements over a book
 * page (a frame) would otherwise go to the frame, not to the app.
 */
let shieldEl: HTMLElement | null = null;
function shield(): () => void {
  const el = document.createElement("div");
  el.className = "drag-shield";
  document.body.appendChild(el);
  shieldEl = el;
  return () => {
    el.remove();
    if (shieldEl === el) shieldEl = null;
  };
}
/** Runs `f` with the drag shield out of the way (for hit testing what is under it). */
function underShield<T>(f: () => T): T {
  const el = shieldEl;
  if (el) el.style.display = "none";
  try {
    return f();
  } finally {
    if (el) el.style.display = "";
  }
}

const isWordChar = (c: string | undefined) => !!c && /[\p{L}\p{N}\p{M}'’]/u.test(c);

/** A caret moved back to the start of its word. */
export const snapStart = (node: Node, offset: number) => snapCaret(node, offset, false);
/** A caret moved forward to the end of its word. */
export const snapEnd = (node: Node, offset: number) => snapCaret(node, offset, true);
/** A caret moved to the nearest word edge: back for a start, forward for an end. */
function snapCaret(node: Node, offset: number, toEnd: boolean): number {
  if (node.nodeType !== Node.TEXT_NODE) return offset;
  const t = node.textContent ?? "";
  let o = offset;
  if (toEnd) while (o < t.length && isWordChar(t[o - 1]) && isWordChar(t[o])) o++;
  else while (o > 0 && isWordChar(t[o]) && isWordChar(t[o - 1])) o--;
  return o;
}

/**
 * The text caret at a point (in `doc`'s measuring units) among the text under `root`.
 * The browser's own hit test first; then, for text it can't hit (PDF.js's invisible text layer
 * under its cover), the nearest text on that line, to the character.
 */
export function caretIn(doc: Document, root: Element, x: number, y: number, hitAt?: { x: number; y: number }): { node: Text; offset: number } | null {
  // `hitAt`: where to hit-test, when that differs from where text measures (a zoomed page).
  const hit = (doc as unknown as { caretRangeFromPoint?(x: number, y: number): Range | null }).caretRangeFromPoint?.(hitAt?.x ?? x, hitAt?.y ?? y);
  if (hit && hit.startContainer.nodeType === Node.TEXT_NODE && root.contains(hit.startContainer) && (hit.startContainer.textContent ?? "").trim()) {
    return { node: hit.startContainer as Text, offset: hit.startOffset };
  }
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let best: { node: Text; d: number; rect: DOMRect } | null = null;
  const r = doc.createRange();
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (!(n.textContent ?? "").trim()) continue;
    r.selectNodeContents(n);
    for (const b of r.getClientRects()) {
      if (!b.width) continue;
      const dy = y < b.top ? b.top - y : y > b.bottom ? y - b.bottom : 0;
      const dx = x < b.left ? b.left - x : x > b.right ? x - b.right : 0;
      const d = dy * 4 + dx;
      if (!best || d < best.d) best = { node: n as Text, d, rect: b };
    }
  }
  if (!best) return null;
  // The character nearest x on that line.
  const t = best.node.textContent ?? "";
  let lo = 0;
  let hi = t.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    r.setStart(best.node, mid);
    r.setEnd(best.node, Math.min(t.length, mid + 1));
    const b = [...r.getClientRects()].find((q) => q.width) ?? r.getBoundingClientRect();
    if (b.left + b.width / 2 < x && !(b.top > best.rect.bottom)) lo = mid + 1;
    else hi = mid;
  }
  return { node: best.node, offset: lo };
}

export interface RangeEditorOptions {
  /** Where the handles go: a positioned element in the app's own document. */
  overlay: HTMLElement;
  range: Range;
  /** The range's boxes on screen (window coordinates). */
  screenRects(r: Range): DOMRect[];
  /** The caret at a point on screen (window coordinates), or null. */
  caretAt(x: number, y: number): { node: Node; offset: number } | null;
  onDrag(r: Range): void;
  onDone(r: Range): void;
  /**
   * Dragging into an edge moves the document: a page turn (after `delay`, then every `repeat`
   * while held there) or a scroll. `nudge` gets the direction (-1, 0 or 1 on each axis) and
   * resolves when the document has moved; the dragged end then follows the pointer again.
   */
  edges?: { bounds(): DOMRect; margin?: number; delay: number; repeat: number; nudge(dx: number, dy: number): Promise<unknown> | unknown; armed?(dx: number, dy: number): void };
}

/**
 * Handles at both ends of a range, as in Apple Books: drag one and that end follows the pointer,
 * snapping to whole words; the ends never cross. The handles sit in the app's document (so book
 * pages and PDF text layers aren't touched) and follow the range when `place` is called.
 */
export function rangeEditor(o: RangeEditorOptions): { place(): void; destroy(): void; range: Range } {
  const range = o.range;
  const make = (end: boolean) => {
    const el = document.createElement("div");
    el.className = `range-handle ${end ? "end" : "start"}`;
    el.setAttribute("role", "slider");
    el.setAttribute("aria-label", end ? "End of the passage" : "Start of the passage");
    el.tabIndex = 0;
    el.appendChild(document.createElement("span")).className = "knob";
    o.overlay.appendChild(el);
    let grab = { dx: 0, dy: 0 };
    let unshield = () => {};
    let last = { x: 0, y: 0 };
    // Held at an edge: the document moves (a page turns, or it scrolls), and the end follows.
    let edgeTimer: ReturnType<typeof setTimeout> | undefined;
    let edgeDir = { dx: 0, dy: 0 };
    let moving = false;
    const edgeOf = (x: number, y: number) => {
      if (!o.edges) return { dx: 0, dy: 0 };
      const b = o.edges.bounds();
      const m = o.edges.margin ?? 32;
      return { dx: x < b.left + m ? -1 : x > b.right - m ? 1 : 0, dy: y < b.top + m ? -1 : y > b.bottom - m ? 1 : 0 };
    };
    const stopEdge = () => {
      clearTimeout(edgeTimer);
      edgeTimer = undefined;
      edgeDir = { dx: 0, dy: 0 };
      o.edges?.armed?.(0, 0);
    };
    const edgeTick = async () => {
      if (!o.edges || moving || (!edgeDir.dx && !edgeDir.dy)) return;
      moving = true;
      try {
        await o.edges.nudge(edgeDir.dx, edgeDir.dy);
      } finally {
        moving = false;
      }
      follow(last.x, last.y);
      if (edgeDir.dx || edgeDir.dy) edgeTimer = setTimeout(() => void edgeTick(), o.edges.repeat);
    };
    const follow = (x: number, y: number) => {
      const c = underShield(() => o.caretAt(x + grab.dx, y + grab.dy));
      if (!c) return;
      const offset = snapCaret(c.node, c.offset, end);
      const probe = range.cloneRange();
      try {
        if (end) probe.setEnd(c.node, offset);
        else probe.setStart(c.node, offset);
      } catch {
        return;
      }
      // The ends never cross (a range collapses if they would), and a passage keeps a word.
      if (probe.collapsed || !probe.toString().trim()) return;
      if (end) range.setEnd(c.node, offset);
      else range.setStart(c.node, offset);
      place();
      o.onDrag(range);
    };
    // The drag is followed on the window, wherever the pointer goes.
    const move = (e: PointerEvent) => {
      last = { x: e.clientX, y: e.clientY };
      const d = edgeOf(e.clientX, e.clientY);
      if (d.dx !== edgeDir.dx || d.dy !== edgeDir.dy) {
        stopEdge();
        edgeDir = d;
        if ((d.dx || d.dy) && o.edges) {
          o.edges.armed?.(d.dx, d.dy);
          edgeTimer = setTimeout(() => void edgeTick(), o.edges.delay);
        }
      }
      follow(e.clientX, e.clientY);
    };
    const finish = () => {
      stopEdge();
      window.removeEventListener("pointermove", move, true);
      window.removeEventListener("pointerup", finish, true);
      window.removeEventListener("pointercancel", finish, true);
      unshield();
      document.body.classList.remove("dragging-handle");
      o.onDone(range);
    };
    el.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const b = el.getBoundingClientRect();
      // Hold the bar's middle under the pointer, wherever on the handle it was taken.
      grab = { dx: b.left + b.width / 2 - e.clientX, dy: b.top + b.height / 2 - e.clientY };
      document.body.classList.add("dragging-handle");
      unshield = shield();
      window.addEventListener("pointermove", move, true);
      window.addEventListener("pointerup", finish, true);
      window.addEventListener("pointercancel", finish, true);
    });
    return el;
  };
  const start = make(false);
  const end = make(true);
  const place = () => {
    const rects = o.screenRects(range).filter((r) => r.width > 0 || r.height > 0);
    const ob = o.overlay.getBoundingClientRect();
    const put = (el: HTMLElement, r: DOMRect | undefined, atEnd: boolean) => {
      el.hidden = !r;
      if (!r) return;
      Object.assign(el.style, { left: `${(atEnd ? r.right : r.left) - ob.left + o.overlay.scrollLeft}px`, top: `${r.top - ob.top + o.overlay.scrollTop}px`, height: `${r.height}px` });
    };
    put(start, rects[0], false);
    put(end, rects[rects.length - 1], true);
  };
  place();
  return {
    range,
    place,
    destroy() {
      start.remove();
      end.remove();
      document.body.classList.remove("dragging-handle");
    },
  };
}

type Rect = { x: number; y: number; w: number; h: number };

/**
 * A frame over a region (percent of `over`) with handles at its corners and edges to resize it,
 * and its inside to move it; it stays within `over`.
 */
export function regionEditor(o: { over: HTMLElement; region: Rect; onDrag(r: Rect): void; onDone(r: Rect): void }): { destroy(): void; place(r?: Rect): void } {
  let r = { ...o.region };
  const box = document.createElement("div");
  box.className = "region-edit";
  box.setAttribute("aria-label", "The captured region: drag to move, or drag a handle to resize");
  const dirs = ["n", "s", "e", "w", "ne", "nw", "se", "sw"] as const;
  for (const d of dirs) {
    const hnd = document.createElement("span");
    hnd.className = `rh ${d}`;
    hnd.dataset.dir = d;
    box.appendChild(hnd);
  }
  if (getComputedStyle(o.over).position === "static") o.over.style.position = "relative";
  o.over.appendChild(box);
  const place = (next?: Rect) => {
    if (next) r = { ...next };
    Object.assign(box.style, { left: `${r.x}%`, top: `${r.y}%`, width: `${r.w}%`, height: `${r.h}%` });
  };
  place();
  const round = (v: number) => Math.round(v * 100) / 100;
  let drag: { dir: string; x: number; y: number; from: Rect } | null = null;
  let unshield = () => {};
  const move = (e: PointerEvent) => {
    if (!drag) return;
    const b = o.over.getBoundingClientRect();
    const dx = ((e.clientX - drag.x) / b.width) * 100;
    const dy = ((e.clientY - drag.y) / b.height) * 100;
    const f = drag.from;
    let { x, y, w, h } = f;
    const min = 1;
    if (drag.dir === "move") {
      x = Math.min(100 - w, Math.max(0, f.x + dx));
      y = Math.min(100 - h, Math.max(0, f.y + dy));
    } else {
      if (drag.dir.includes("e")) w = Math.max(min, Math.min(100 - f.x, f.w + dx));
      if (drag.dir.includes("s")) h = Math.max(min, Math.min(100 - f.y, f.h + dy));
      if (drag.dir.includes("w")) {
        x = Math.max(0, Math.min(f.x + f.w - min, f.x + dx));
        w = f.x + f.w - x;
      }
      if (drag.dir.includes("n")) {
        y = Math.max(0, Math.min(f.y + f.h - min, f.y + dy));
        h = f.y + f.h - y;
      }
    }
    place({ x: round(x), y: round(y), w: round(w), h: round(h) });
    o.onDrag(r);
  };
  const finish = () => {
    if (!drag) return;
    drag = null;
    window.removeEventListener("pointermove", move, true);
    window.removeEventListener("pointerup", finish, true);
    window.removeEventListener("pointercancel", finish, true);
    unshield();
    document.body.classList.remove("dragging-handle");
    o.onDone(r);
  };
  box.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    drag = { dir: (e.target as HTMLElement).dataset.dir ?? "move", x: e.clientX, y: e.clientY, from: { ...r } };
    document.body.classList.add("dragging-handle");
    unshield = shield();
    window.addEventListener("pointermove", move, true);
    window.addEventListener("pointerup", finish, true);
    window.addEventListener("pointercancel", finish, true);
  });
  return { destroy: () => box.remove(), place };
}
