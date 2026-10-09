/**
 * Places drawn over a page or an image, all in percent so they survive zooming: selection
 * boxes, marks (saved and pending captures), Show's brief brightening, region outlines, and the
 * region drag.
 */
import type { Box, Mark } from "./types";

/** An element's box inside its border (where its absolutely placed children go). */
export function innerRect(el: HTMLElement): DOMRect {
  const b = el.getBoundingClientRect();
  return new DOMRect(b.left + el.clientLeft, b.top + el.clientTop, el.clientWidth || b.width, el.clientHeight || b.height);
}

const positioned = (el: HTMLElement) => {
  if (getComputedStyle(el).position === "static") el.style.position = "relative";
};

/** A div placed by a percent box. */
function boxEl(className: string, b: { x: number; y: number; w: number; h: number }): HTMLDivElement {
  const el = document.createElement("div");
  el.className = className;
  Object.assign(el.style, { left: `${b.x}%`, top: `${b.y}%`, width: `${b.w}%`, height: `${b.h}%` });
  return el;
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

function grow(prev: Edges, r: Edges): void {
  prev.l = Math.min(prev.l, r.l);
  prev.r = Math.max(prev.r, r.r);
  prev.t = Math.min(prev.t, r.t);
  prev.b = Math.max(prev.b, r.b);
}

/**
 * Boxes (percent of an element `width` × `height` pixels) joined into one per line, as a
 * selection is drawn. Older captures have one box per word.
 */
export function joinLines(boxes: Box[], width: number, height: number): Box[] {
  if (!width || !height) return boxes;
  const out: (Edges & { page?: number })[] = [];
  for (const x of boxes) {
    const r = { l: (x.x * width) / 100, t: (x.y * height) / 100, r: ((x.x + x.w) * width) / 100, b: ((x.y + x.h) * height) / 100 };
    const prev = out[out.length - 1];
    if (prev && prev.page === x.page && sameLine(prev, r)) grow(prev, r);
    else out.push({ ...r, page: x.page });
  }
  return out.map((r) => ({ ...(r.page !== undefined ? { page: r.page } : {}), x: (r.l / width) * 100, y: (r.t / height) * 100, w: ((r.r - r.l) / width) * 100, h: ((r.b - r.t) / height) * 100 }));
}

/**
 * A range's boxes in percent of `over`, one per line. "One line" is judged in pixels: in percent
 * of a very tall page (a saved web page), whole lines are a fraction of a percent apart.
 */
export function boxesIn(range: Range, over: HTMLElement, page?: number): Box[] {
  const b = innerRect(over);
  if (!b.width || !b.height) return [];
  const pct = (v: number, of: number) => Math.round((v / of) * 10000) / 100;
  const lines: Edges[] = [];
  for (const r of range.getClientRects()) {
    if (r.width < 1 || r.height < 1) continue;
    const e = { l: Math.max(r.left, b.left), t: Math.max(r.top, b.top), r: Math.min(r.right, b.right), b: Math.min(r.bottom, b.bottom) };
    if (e.r <= e.l || e.b <= e.t) continue;
    const prev = lines[lines.length - 1];
    if (prev && sameLine(prev, e)) grow(prev, e);
    else lines.push(e);
  }
  return lines.map((x) => ({ ...(page ? { page } : {}), x: pct(x.l - b.left, b.width), y: pct(x.t - b.top, b.height), w: pct(x.r - x.l, b.width), h: pct(x.b - x.t, b.height) }));
}

export const isWordChar = (c: string | undefined) => !!c && /[\p{L}\p{N}\p{M}'’]/u.test(c);

/**
 * Widens a mouse selection to whole words, as Books and Kindle do: a drag that starts or ends
 * inside a word takes the whole word. Keeps the selection's direction.
 */
export function snapToWords(sel: Selection | null): void {
  if (!sel || sel.rangeCount !== 1 || sel.isCollapsed) return;
  const r = sel.getRangeAt(0);
  let so = r.startOffset;
  let eo = r.endOffset;
  const { startContainer: sc, endContainer: ec } = r;
  if (sc.nodeType === Node.TEXT_NODE) {
    const t = sc.textContent ?? "";
    while (so > 0 && isWordChar(t[so]) && isWordChar(t[so - 1])) so--;
  }
  if (ec.nodeType === Node.TEXT_NODE) {
    const t = ec.textContent ?? "";
    while (eo < t.length && isWordChar(t[eo - 1]) && isWordChar(t[eo])) eo++;
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

/** Draws marks over an element (only `page`'s, if given), replacing those drawn there before. */
export function drawMarks(over: HTMLElement, marks: Mark[], page?: number): void {
  over.querySelectorAll(":scope > .reader-mark").forEach((n) => n.remove());
  positioned(over);
  const box = innerRect(over);
  for (const m of marks) {
    const mine = m.boxes.filter((b) => page === undefined || b.page === page);
    for (const b of m.region ? mine : joinLines(mine, box.width, box.height)) {
      const el = boxEl(`reader-mark${m.region ? " region" : ""}${m.saved ? " saved" : ""}`, b);
      el.dataset.mark = m.id;
      over.appendChild(el);
    }
  }
}

/**
 * Reports plain clicks on saved marks drawn in `over` (marks don't take clicks, so the text
 * under them can still be selected): the IDs of the marks under the pointer.
 */
export function watchMarkClicks(over: HTMLElement, cb: (ids: string[], at: { x: number; y: number }) => void): () => void {
  const click = (e: MouseEvent) => {
    if (e.button !== 0 || window.getSelection()?.toString().trim()) return;
    const ids = new Set<string>();
    for (const m of over.querySelectorAll<HTMLElement>(".reader-mark.saved")) {
      const r = m.getBoundingClientRect();
      if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom && m.dataset.mark) ids.add(m.dataset.mark);
    }
    if (ids.size) cb([...ids], { x: e.clientX, y: e.clientY });
  };
  over.addEventListener("click", click);
  return () => over.removeEventListener("click", click);
}

/**
 * Brings out a passage for a moment (its line boxes, percent of `over`): Show lands on the
 * passage itself rather than a frame around it. Returns the first line.
 */
export function flashPlace(over: HTMLElement, boxes: Box[], page?: number): HTMLElement | undefined {
  over.querySelectorAll(".region-mark, .place-mark").forEach((n) => n.remove());
  positioned(over);
  const box = innerRect(over);
  let first: HTMLElement | undefined;
  for (const b of joinLines(boxes.filter((x) => page === undefined || x.page === page), box.width, box.height)) {
    const el = over.appendChild(boxEl("place-mark", b));
    setTimeout(() => el.remove(), 2600);
    first ??= el;
  }
  return first;
}

/** Outlines a region (percent) over an element. */
export function outlineRegion(over: HTMLElement, r: { x: number; y: number; w: number; h: number }): HTMLElement {
  over.querySelectorAll(".region-mark").forEach((n) => n.remove());
  positioned(over);
  return over.appendChild(boxEl("region-mark", r));
}

/** Crops a canvas or image (in its own pixels) to a PNG data URL. */
export function cropToPng(src: HTMLCanvasElement | HTMLImageElement, sx: number, sy: number, sw: number, sh: number): string {
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(sw));
  c.height = Math.max(1, Math.round(sh));
  c.getContext("2d")!.drawImage(src, sx, sy, sw, sh, 0, 0, c.width, c.height);
  return c.toDataURL("image/png");
}

/**
 * Lets the user drag a rectangle over the visible part of `scroller`; resolves with it in
 * window coordinates, or null on Escape or a click without a drag. The wheel still scrolls the
 * document underneath, and the drag follows the mouse even outside the layer.
 */
export function dragRect(scroller: HTMLElement): Promise<DOMRect | null> {
  return new Promise((resolve) => {
    const hint = Object.assign(document.createElement("div"), { className: "region-hint", textContent: "Drag over the region to capture. Escape cancels." });
    const box = Object.assign(document.createElement("div"), { className: "region-box" });
    const layer = Object.assign(document.createElement("div"), { className: "region-layer" });
    layer.append(hint, box);
    const place = () => {
      const b = scroller.getBoundingClientRect();
      Object.assign(layer.style, { left: `${b.left}px`, top: `${b.top}px`, width: `${b.width}px`, height: `${b.height}px` });
    };
    place();
    document.body.appendChild(layer);
    let start: { x: number; y: number } | null = null;
    let last = { x: 0, y: 0 };
    const draw = () => {
      if (!start) return;
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
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      done(null);
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
      const x = Math.max(b.left, Math.min(start.x, last.x));
      const y = Math.max(b.top, Math.min(start.y, last.y));
      const r = new DOMRect(x, y, Math.min(b.right, Math.max(start.x, last.x)) - x, Math.min(b.bottom, Math.max(start.y, last.y)) - y);
      done(r.width > 4 && r.height > 4 ? r : null);
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("mousemove", onMove, true);
    window.addEventListener("mouseup", onUp, true);
    window.addEventListener("resize", place);
    layer.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      start = last = { x: e.clientX, y: e.clientY };
      hint.hidden = true;
      e.preventDefault();
    });
    layer.addEventListener("wheel", (e) => {
      scroller.scrollBy({ left: e.deltaX, top: e.deltaY });
      e.preventDefault();
    }, { passive: false });
  });
}

/** A region dragged over `pageEl` (window rect), as percent of the page, or null if too small. */
export function regionOn(pageEl: HTMLElement, r: DOMRect): { x: number; y: number; w: number; h: number; px: DOMRect } | null {
  const b = innerRect(pageEl);
  const x = Math.max(0, r.left - b.left);
  const y = Math.max(0, r.top - b.top);
  const w = Math.min(b.width - x, r.right - b.left - x);
  const h = Math.min(b.height - y, r.bottom - b.top - y);
  if (w < 4 || h < 4) return null;
  const pct = (v: number, of: number) => Math.round((v / of) * 10000) / 100;
  return { x: pct(x, b.width), y: pct(y, b.height), w: pct(w, b.width), h: pct(h, b.height), px: new DOMRect(x, y, w, h) };
}
