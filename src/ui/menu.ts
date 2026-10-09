/**
 * A context menu (role="menu"): opens at a point, moves with the arrow keys, Home and End,
 * runs an item with Enter, Space or a click, and closes on Escape, Tab, a click elsewhere or
 * scrolling, giving focus back to where it was.
 */
import { h } from "./dom";

export type MenuItem = { label: string; run: () => void; destructive?: boolean } | "separator";
export type Point = { x: number; y: number };

let closeOpen: (() => void) | null = null;

/** Opens a menu at a point in window coordinates; returns a function that closes it. */
export function contextMenu(items: MenuItem[], at: Point, label = "Actions"): () => void {
  closeOpen?.();
  const previous = document.activeElement as HTMLElement | null;
  const buttons: HTMLElement[] = [];
  const el = h("div", { class: "context-menu", role: "menu", "aria-label": label },
    items.map((it) => {
      if (it === "separator") return h("div", { class: "context-sep", role: "separator" });
      const b = h("div", { class: `context-item${it.destructive ? " destructive" : ""}`, role: "menuitem", tabindex: "-1" }, it.label);
      b.addEventListener("click", (e) => (e.stopPropagation(), close(), it.run()));
      b.addEventListener("mousemove", () => b.focus({ preventScroll: true }));
      buttons.push(b);
      return b;
    }),
  );
  document.body.appendChild(el);
  // Keep it on screen.
  const r = el.getBoundingClientRect();
  const x = Math.max(4, Math.min(at.x, window.innerWidth - r.width - 4));
  const y = at.y + r.height > window.innerHeight - 4 ? Math.max(4, at.y - r.height) : at.y;
  Object.assign(el.style, { left: `${x}px`, top: `${y}px` });
  buttons[0]?.focus({ preventScroll: true });

  const move = (to: (i: number, n: number) => number) => {
    const i = buttons.indexOf(document.activeElement as HTMLElement);
    buttons[to(i, buttons.length)]?.focus({ preventScroll: true });
  };
  const click = () => (document.activeElement as HTMLElement | null)?.click();
  const KEYS: Record<string, () => void> = {
    ArrowDown: () => move((i, n) => (i + 1) % n),
    ArrowUp: () => move((i, n) => (i - 1 + n) % n),
    Home: () => move(() => 0),
    End: () => move((_, n) => n - 1),
    Escape: () => close(true),
    Tab: () => close(true),
    Enter: click,
    " ": click,
  };
  const onKey = (e: KeyboardEvent) => {
    const k = KEYS[e.key];
    if (!k) return;
    e.preventDefault();
    e.stopPropagation();
    k();
  };
  const outside = (e: Event) => !el.contains(e.target as Node) && close();
  const onBlur = () => close();
  window.addEventListener("keydown", onKey, true);
  window.addEventListener("mousedown", outside, true);
  window.addEventListener("scroll", outside, true);
  window.addEventListener("blur", onBlur);
  let closed = false;
  function close(restore = false) {
    if (closed) return;
    closed = true;
    closeOpen = null;
    el.remove();
    window.removeEventListener("keydown", onKey, true);
    window.removeEventListener("mousedown", outside, true);
    window.removeEventListener("scroll", outside, true);
    window.removeEventListener("blur", onBlur);
    if (restore) previous?.focus?.({ preventScroll: true });
  }
  closeOpen = () => close();
  return closeOpen;
}

/** Where to open a context menu asked for from the keyboard: by the focused element. */
export function menuPointFor(el: Element): Point {
  const r = el.getBoundingClientRect();
  return { x: r.left + Math.min(24, r.width / 2), y: r.bottom };
}

/** Whether a key press asks for the context menu (the menu key, or ⇧F10). */
export function isMenuKey(e: KeyboardEvent): boolean {
  return e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey);
}
