/**
 * A handle on the edge of a panel that resizes it: dragged, or with ← and → while focused (⇧ for
 * larger steps). A double-click puts the panel back to its usual width.
 */
import { h } from "./dom";
import type { Signal } from "./signal";

export interface Resize {
  label: string;
  /** The panel's width in pixels (saved by whoever owns it). */
  width: Signal<number>;
  min: number;
  max: number;
  /** The usual width, for a double-click. */
  usual: number;
  /** 1 when the panel is left of the handle (moving right widens it), -1 when right of it. */
  grows: 1 | -1;
}

const STEP = 16;

export function resizeHandle(o: Resize): HTMLElement {
  const clamp = (w: number) => Math.round(Math.min(o.max, Math.max(o.min, w)));
  const el = h("div", { class: "resize-handle", role: "separator", tabindex: "0", "aria-orientation": "vertical", "aria-label": o.label, "aria-valuemin": String(o.min), "aria-valuemax": String(o.max), title: `${o.label} (double-click for the usual width)` });
  const set = (w: number) => (o.width.set(clamp(w)), el.setAttribute("aria-valuenow", String(o.width.peek())));
  el.setAttribute("aria-valuenow", String(o.width.peek()));
  el.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const from = e.clientX;
    const start = o.width.peek();
    document.body.classList.add("resizing");
    // Followed on the window, so the pointer can leave the thin handle (and whatever holds it).
    const move = (m: PointerEvent) => set(start + o.grows * (m.clientX - from));
    const end = () => {
      document.body.classList.remove("resizing");
      window.removeEventListener("pointermove", move, true);
      window.removeEventListener("pointerup", end, true);
      window.removeEventListener("pointercancel", end, true);
    };
    window.addEventListener("pointermove", move, true);
    window.addEventListener("pointerup", end, true);
    window.addEventListener("pointercancel", end, true);
  });
  el.addEventListener("dblclick", () => set(o.usual));
  el.addEventListener("keydown", (e) => {
    const dir = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (!dir) return;
    e.preventDefault();
    e.stopPropagation();
    set(o.width.peek() + dir * o.grows * (e.shiftKey ? STEP * 4 : STEP));
  });
  return el;
}
