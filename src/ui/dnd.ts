/**
 * Dragging records and folders inside the window, with the pointer. Not the platform's drag
 * and drop: the desktop shell claims every drag over the window (to take files dropped from
 * Finder), so a page's own drags would never land. A drag starts after the pointer moves a few
 * pixels with the button down; a badge follows it; what is under it is asked whether it takes
 * the drag (and is marked `.drop-over`, `.drop-before` or `.drop-after`); Escape cancels.
 */
export interface DragPayload {
  records: string[];
  /** Folder paths, of `kind`'s folders. */
  folders: string[];
  /** The kind of record (and so of folders) dragged, when it is one kind; else "". */
  kind: string;
}

/** Where a drop goes: into the element, or just before or after it (to arrange things). */
export type Where = "into" | "before" | "after";

export interface DropTarget {
  accepts(p: DragPayload): boolean;
  /** Where a drop at this point would go (default: into); null passes it to what is around. */
  where?(p: DragPayload, x: number, y: number, el: HTMLElement): Where | null;
  drop(p: DragPayload, where: Where): void;
}

const MARKS: Record<Where, string> = { into: "drop-over", before: "drop-before", after: "drop-after" };
const targets = new WeakMap<Element, DropTarget>();
const START = 5;

export function dropTarget(el: HTMLElement, t: DropTarget): void {
  targets.set(el, t);
}

/** The innermost drop target at a point that takes this payload, and where. */
function targetAt(x: number, y: number, p: DragPayload): { el: HTMLElement; t: DropTarget; where: Where } | null {
  for (let el = document.elementFromPoint(x, y) as HTMLElement | null; el; el = el.parentElement) {
    const t = targets.get(el);
    if (!t?.accepts(p)) continue;
    const where = t.where ? t.where(p, x, y, el) : "into";
    if (where) return { el, t, where };
  }
  return null;
}

/** Which part of an element a point is over, for lists (top/bottom) or grids (left/right):
 * the outer `edge` share at each end is before/after, the rest is into (if `into`). */
export function zone(el: HTMLElement, x: number, y: number, o: { horizontal?: boolean; into: boolean; edge?: number }): Where {
  const r = el.getBoundingClientRect();
  const size = o.horizontal ? r.width : r.height;
  const at = o.horizontal ? x - r.left : y - r.top;
  if (!o.into || !size) return at < size / 2 ? "before" : "after";
  const edge = size * (o.edge ?? 0.25);
  return at < edge ? "before" : at > size - edge ? "after" : "into";
}

function scrollerAt(el: Element | null): HTMLElement | null {
  for (let e = el as HTMLElement | null; e; e = e.parentElement) {
    const s = getComputedStyle(e).overflowY;
    if ((s === "auto" || s === "scroll") && e.scrollHeight > e.clientHeight) return e;
  }
  return null;
}

/**
 * Lets the pointer drag things out of `container`: `start(target)` says what a press on that
 * element carries (or null: not draggable). Returns a function that stops it.
 */
export function dragSource(container: HTMLElement, start: (target: HTMLElement) => { payload: DragPayload; label: string } | null): () => void {
  const down = (e: PointerEvent) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey) return;
    const t = e.target as HTMLElement;
    if (t.closest("input, textarea, [contenteditable=true], .no-drag")) return;
    const from = { x: e.clientX, y: e.clientY };
    let drag: { payload: DragPayload; label: string } | null = null;
    let badge: HTMLElement | null = null;
    let over: { el: HTMLElement; where: Where } | null = null;
    const mark = (hit: { el: HTMLElement; where: Where } | null) => {
      if (over?.el === hit?.el && over?.where === hit?.where) return;
      over?.el.classList.remove(MARKS[over.where]);
      over = hit;
      over?.el.classList.add(MARKS[over.where]);
    };
    const move = (m: PointerEvent) => {
      if (!drag) {
        if (Math.abs(m.clientX - from.x) + Math.abs(m.clientY - from.y) < START) return;
        drag = start(t);
        const n = drag ? drag.payload.records.length + drag.payload.folders.length : 0;
        if (!drag || !n) return finish();
        badge = document.createElement("div");
        badge.className = "drag-badge";
        badge.textContent = n === 1 ? drag.label : `${n} items`;
        document.body.appendChild(badge);
        document.body.classList.add("dragging-items");
      }
      m.preventDefault();
      Object.assign(badge!.style, { left: `${m.clientX + 12}px`, top: `${m.clientY + 10}px` });
      mark(targetAt(m.clientX, m.clientY, drag.payload));
      // Near the top or bottom of a scrolling list: scroll it.
      const s = scrollerAt(document.elementFromPoint(m.clientX, m.clientY));
      if (s) {
        const r = s.getBoundingClientRect();
        if (m.clientY < r.top + 32) s.scrollTop -= 12;
        else if (m.clientY > r.bottom - 32) s.scrollTop += 12;
      }
    };
    const up = (u: PointerEvent) => {
      const d = drag;
      const hit = d ? targetAt(u.clientX, u.clientY, d.payload) : null;
      finish();
      if (!d) return;
      // The click that ends a drag isn't a click.
      const swallow = (c: MouseEvent) => (c.stopPropagation(), c.preventDefault());
      window.addEventListener("click", swallow, { capture: true, once: true });
      setTimeout(() => window.removeEventListener("click", swallow, { capture: true }), 0);
      hit?.t.drop(d.payload, hit.where);
    };
    const key = (k: KeyboardEvent) => {
      if (k.key !== "Escape" || !drag) return;
      k.preventDefault();
      k.stopPropagation();
      cancel();
    };
    const cancel = () => {
      drag = null;
      finish();
    };
    const finish = () => {
      mark(null);
      badge?.remove();
      document.body.classList.remove("dragging-items");
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("keydown", key, true);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("keydown", key, true);
  };
  container.addEventListener("pointerdown", down);
  return () => container.removeEventListener("pointerdown", down);
}
