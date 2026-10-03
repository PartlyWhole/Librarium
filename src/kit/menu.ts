/**
 * A context menu (role="menu"): opens at a point, moves with the arrow keys, Home and End,
 * runs an item with Enter, Space or a click, and closes on Escape, Tab, a click elsewhere or
 * scrolling, giving focus back to where it was.
 */
import { h } from "./dom";

export type MenuItem = { label: string; run: () => void; destructive?: boolean } | "separator";

let open: (() => void) | null = null;

/** Opens a menu at (x, y) in window coordinates; returns a function that closes it. */
export function contextMenu(items: MenuItem[], at: { x: number; y: number }, label = "Actions"): () => void {
  open?.();
  const previous = document.activeElement as HTMLElement | null;
  const buttons: HTMLElement[] = [];
  const el = h("div", { class: "context-menu", role: "menu", "aria-label": label },
    items.map((it) => {
      if (it === "separator") return h("div", { class: "context-sep", role: "separator" });
      const b = h("div", { class: `context-item${it.destructive ? " destructive" : ""}`, role: "menuitem", tabindex: "-1" }, it.label);
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        close();
        it.run();
      });
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

  const move = (d: number | "first" | "last") => {
    const i = buttons.indexOf(document.activeElement as HTMLElement);
    const n = d === "first" ? 0 : d === "last" ? buttons.length - 1 : (i + d + buttons.length) % buttons.length;
    buttons[n]?.focus({ preventScroll: true });
  };
  const onKey = (e: KeyboardEvent) => {
    const keys: Record<string, () => void> = {
      ArrowDown: () => move(1),
      ArrowUp: () => move(-1),
      Home: () => move("first"),
      End: () => move("last"),
      Escape: () => close(true),
      Tab: () => close(true),
      Enter: () => (document.activeElement as HTMLElement | null)?.click(),
      " ": () => (document.activeElement as HTMLElement | null)?.click(),
    };
    const k = keys[e.key];
    if (!k) return;
    e.preventDefault();
    e.stopPropagation();
    k();
  };
  const onDown = (e: MouseEvent) => {
    if (!el.contains(e.target as Node)) close();
  };
  const onScroll = (e: Event) => {
    if (!el.contains(e.target as Node)) close();
  };
  window.addEventListener("keydown", onKey, true);
  window.addEventListener("mousedown", onDown, true);
  window.addEventListener("scroll", onScroll, true);
  window.addEventListener("blur", () => close());
  let closed = false;
  function close(restore = false) {
    if (closed) return;
    closed = true;
    open = null;
    el.remove();
    window.removeEventListener("keydown", onKey, true);
    window.removeEventListener("mousedown", onDown, true);
    window.removeEventListener("scroll", onScroll, true);
    if (restore) previous?.focus?.({ preventScroll: true });
  }
  open = () => close();
  return () => close();
}

/** Where to open a context menu for a keyboard request: by the focused element. */
export function menuPointFor(el: Element): { x: number; y: number } {
  const r = el.getBoundingClientRect();
  return { x: r.left + Math.min(24, r.width / 2), y: r.bottom };
}

/** Whether a key press asks for the context menu (the menu key, or ⇧F10). */
export function isMenuKey(e: KeyboardEvent): boolean {
  return e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey);
}
