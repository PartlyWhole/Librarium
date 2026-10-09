/**
 * Editing a capture's parts in place, as in Apple Books: word-snapped handles at both ends of a
 * passage, and a frame to move or resize a region. The handles live in the app's own document,
 * so book pages and PDF text layers are never touched.
 */
import { isWordChar } from "./marks";

/**
 * A transparent cover over the window while something is dragged: pointer movements over a
 * book page (a frame) would otherwise go to the frame, not to the app.
 */
let shieldEl: HTMLElement | null = null;
function shield(): () => void {
  const el = Object.assign(document.createElement("div"), { className: "drag-shield" });
  document.body.appendChild(el);
  document.body.classList.add("dragging-handle");
  shieldEl = el;
  return () => {
    el.remove();
    document.body.classList.remove("dragging-handle");
    if (shieldEl === el) shieldEl = null;
  };
}

/** Runs `f` with the shield out of the way (to hit-test what is under it). */
function underShield<T>(f: () => T): T {
  const el = shieldEl;
  if (el) el.style.display = "none";
  try {
    return f();
  } finally {
    if (el) el.style.display = "";
  }
}

/** A caret moved to the nearest word edge: back for a start, forward for an end. */
function snapCaret(node: Node, offset: number, toEnd: boolean): number {
  if (node.nodeType !== Node.TEXT_NODE) return offset;
  const t = node.textContent ?? "";
  let o = offset;
  if (toEnd) while (o < t.length && isWordChar(t[o - 1]) && isWordChar(t[o])) o++;
  else while (o > 0 && isWordChar(t[o]) && isWordChar(t[o - 1])) o--;
  return o;
}
export const snapStart = (node: Node, offset: number) => snapCaret(node, offset, false);
export const snapEnd = (node: Node, offset: number) => snapCaret(node, offset, true);

/**
 * The text caret at a point among the text under `root`. The browser's own hit test first;
 * then, for text it can't hit (PDF.js's text layer under its cover), the nearest text on that
 * line, to the character. `hitAt` is where to hit-test when that differs from where text
 * measures (a zoomed book page).
 */
export function caretIn(doc: Document, root: Element, x: number, y: number, hitAt?: { x: number; y: number }): { node: Text; offset: number } | null {
  const hit = (doc as Document & { caretRangeFromPoint?(x: number, y: number): Range | null }).caretRangeFromPoint?.(hitAt?.x ?? x, hitAt?.y ?? y);
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

/** A range from a part's drawn boxes: the first box's start to the last one's end, word-snapped. */
export function rangeFromBoxes<B extends { x: number; y: number; w: number; h: number }>(boxes: B[], at: (b: B, right: boolean) => { node: Node; offset: number } | null): Range | null {
  if (!boxes.length) return null;
  const a = at(boxes[0]!, false);
  const z = at(boxes[boxes.length - 1]!, true);
  if (!a || !z) return null;
  const r = document.createRange();
  try {
    r.setStart(a.node, snapStart(a.node, a.offset));
    r.setEnd(z.node, snapEnd(z.node, z.offset));
  } catch {
    return null;
  }
  return r.collapsed ? null : r;
}

/**
 * Dragging into an edge moves the document: a page turn (after `delay`, then every `repeat`
 * while held there) or a scroll. `nudge` gets the direction (-1, 0 or 1 on each axis) and
 * resolves once the document has moved; the dragged end then follows the pointer again.
 */
export interface Edges {
  bounds(): DOMRect;
  margin?: number;
  delay: number;
  repeat: number;
  nudge(dx: number, dy: number): Promise<unknown> | unknown;
  armed?(dx: number, dy: number): void;
}

export interface RangeEditorOptions {
  /** Where the handles go: a positioned element in the app's own document. */
  overlay: HTMLElement;
  range: Range;
  /** The range's boxes on screen (window coordinates). */
  screenRects(r: Range): DOMRect[];
  /** The caret at a point on screen (window coordinates). */
  caretAt(x: number, y: number): { node: Node; offset: number } | null;
  onDrag(r: Range): void;
  onDone(r: Range): void;
  edges?: Edges;
}

/** Handles at both ends of a range: drag one and that end follows, snapping to words; the ends never cross. */
export function rangeEditor(o: RangeEditorOptions): { place(): void; destroy(): void } {
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
      o.onDone(range);
    };
    el.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const b = el.getBoundingClientRect();
      // The bar's middle stays under the pointer, wherever on the handle it was taken.
      grab = { dx: b.left + b.width / 2 - e.clientX, dy: b.top + b.height / 2 - e.clientY };
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
      if (r) Object.assign(el.style, { left: `${(atEnd ? r.right : r.left) - ob.left + o.overlay.scrollLeft}px`, top: `${r.top - ob.top + o.overlay.scrollTop}px`, height: `${r.height}px` });
    };
    put(start, rects[0], false);
    put(end, rects[rects.length - 1], true);
  };
  place();
  return {
    place,
    destroy() {
      start.remove();
      end.remove();
    },
  };
}

type Rect = { x: number; y: number; w: number; h: number };

/** A frame over a region (percent of `over`): its edges and corners resize it, its inside moves it. */
export function regionEditor(o: { over: HTMLElement; region: Rect; onDrag(r: Rect): void; onDone(r: Rect): void }): { destroy(): void } {
  let r = { ...o.region };
  const box = document.createElement("div");
  box.className = "region-edit";
  box.setAttribute("aria-label", "The captured region: drag to move, or drag a handle to resize");
  for (const d of ["n", "s", "e", "w", "ne", "nw", "se", "sw"]) {
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
    o.onDone(r);
  };
  box.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    drag = { dir: (e.target as HTMLElement).dataset.dir ?? "move", x: e.clientX, y: e.clientY, from: { ...r } };
    unshield = shield();
    window.addEventListener("pointermove", move, true);
    window.addEventListener("pointerup", finish, true);
    window.addEventListener("pointercancel", finish, true);
  });
  return { destroy: () => box.remove() };
}
