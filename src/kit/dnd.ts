/**
 * Dragging records and folders inside the window, with the pointer. Not the platform's drag
 * and drop: the desktop shell claims every drag over the window (to take files dropped from
 * Finder), so a page's own drags would never be dropped. A drag starts after the pointer moves
 * a few pixels with the button down; a badge follows it; what is under it is asked whether it
 * takes the drag (and is marked `.drop-over`); Escape cancels.
 */
export interface DragPayload {
  records: string[];
  folders: string[];
}

export interface DropTarget {
  /** Whether this payload may be dropped here (e.g. not a folder into itself). */
  accepts(p: DragPayload): boolean;
  drop(p: DragPayload): void;
}

const targets = new WeakMap<Element, DropTarget>();
const START = 5;

/** Makes an element a drop target. */
export function dropTarget(el: HTMLElement, t: DropTarget): void {
  targets.set(el, t);
}

/** The innermost drop target at a point that takes this payload. */
function targetAt(x: number, y: number, p: DragPayload): { el: HTMLElement; t: DropTarget } | null {
  let el = (document.elementFromPoint?.(x, y) ?? null) as HTMLElement | null;
  for (; el; el = el.parentElement) {
    const t = targets.get(el);
    if (t) return t.accepts(p) ? { el, t } : null;
  }
  return null;
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
 * element would carry (or null: not draggable). Returns a function that stops it.
 */
export function dragSource(container: HTMLElement, start: (target: HTMLElement) => { payload: DragPayload; label: string } | null): () => void {
  const down = (e: PointerEvent) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey) return;
    const t = e.target as HTMLElement;
    if (t.closest("input, textarea, [contenteditable=true], .no-drag")) return;
    const from = { x: e.clientX, y: e.clientY };
    let drag: { payload: DragPayload; label: string } | null = null;
    let badge: HTMLElement | null = null;
    let over: HTMLElement | null = null;
    const mark = (el: HTMLElement | null) => {
      if (over === el) return;
      over?.classList.remove("drop-over");
      over = el;
      over?.classList.add("drop-over");
    };
    const move = (m: PointerEvent) => {
      if (!drag) {
        if (Math.abs(m.clientX - from.x) + Math.abs(m.clientY - from.y) < START) return;
        drag = start(t);
        if (!drag || !(drag.payload.records.length + drag.payload.folders.length)) return finish();
        badge = document.createElement("div");
        badge.className = "drag-badge";
        const n = drag.payload.records.length + drag.payload.folders.length;
        badge.textContent = n === 1 ? drag.label : `${n} items`;
        document.body.appendChild(badge);
        document.body.classList.add("dragging-items");
      }
      m.preventDefault();
      Object.assign(badge!.style, { left: `${m.clientX + 12}px`, top: `${m.clientY + 10}px` });
      const hit = targetAt(m.clientX, m.clientY, drag.payload);
      mark(hit?.el ?? null);
      // Near the top or bottom of a scrolling list: scroll it.
      const s = scrollerAt(document.elementFromPoint?.(m.clientX, m.clientY) ?? null);
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
      hit?.t.drop(d.payload);
    };
    const key = (k: KeyboardEvent) => {
      if (k.key !== "Escape" || !drag) return;
      k.preventDefault();
      k.stopPropagation();
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
    const cancel = () => {
      drag = null;
      finish();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("keydown", key, true);
  };
  container.addEventListener("pointerdown", down);
  return () => container.removeEventListener("pointerdown", down);
}
