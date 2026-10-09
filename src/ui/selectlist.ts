/**
 * Selecting several things in a list, as on the Mac, and a list that does it (the APG listbox
 * pattern, multi-selectable): a click opens an item, ⌘-click and ⇧-click select; ↑/↓ move,
 * ⇧↑/⇧↓ extend the selection, Return opens, ⌘A selects all, Escape leaves one; right-click,
 * the menu key or ⇧F10 offer the selected items' menu.
 */
import { h, type Child } from "./dom";
import { isMenuKey, menuPointFor, type Point } from "./menu";
import { signal, type ReadSignal } from "./signal";

export class Selection {
  readonly ids = signal<ReadonlySet<string>>(new Set());
  private anchor: string | null = null;

  /** The selected IDs, in the list's order. */
  inOrder(order: readonly string[]): string[] {
    const s = this.ids.peek();
    return order.filter((id) => s.has(id));
  }

  set(ids: Iterable<string>, anchor?: string): void {
    this.ids.set(new Set(ids));
    if (anchor !== undefined) this.anchor = anchor;
  }

  clear(): void {
    this.ids.set(new Set());
    this.anchor = null;
  }

  /** Applies a click on `id`; true when it was a plain click (the item should open). */
  click(id: string, order: readonly string[], mods: { meta: boolean; shift: boolean }): boolean {
    if (mods.shift && this.anchor && order.includes(this.anchor)) {
      this.ids.set(new Set(range(order, this.anchor, id)));
      return false;
    }
    this.anchor = id;
    if (mods.meta) {
      const s = new Set(this.ids.peek());
      if (!s.delete(id)) s.add(id);
      this.ids.set(s);
      return false;
    }
    this.ids.set(new Set([id]));
    return true;
  }

  /** ⇧↑/⇧↓: extends the selection from the anchor to `to`. */
  extendTo(to: string, order: readonly string[]): void {
    if (!this.anchor || !order.includes(this.anchor)) this.anchor = to;
    this.ids.set(new Set(range(order, this.anchor, to)));
  }

  /** What a context menu on `id` acts on: the selection when `id` is in it, else just `id`. */
  forMenu(id: string, order: readonly string[]): string[] {
    if (this.ids.peek().has(id) && this.ids.peek().size > 1) return this.inOrder(order);
    this.set([id], id);
    return [id];
  }
}

function range(order: readonly string[], a: string, b: string): string[] {
  const i = order.indexOf(a);
  const j = order.indexOf(b);
  if (i < 0 || j < 0) return [b];
  return order.slice(Math.min(i, j), Math.max(i, j) + 1);
}

interface SelectListOptions<T> {
  label: string;
  items: T[];
  id(t: T): string;
  render(t: T): Child;
  open(t: T): void;
  menu(ts: T[], at: Point): void;
  selection: Selection;
  className?: string;
  /** Select mode: a click ticks an item instead of opening it. */
  mode?: ReadSignal<boolean>;
}

/** The list element, with `sync()` to redraw the selection after it changed elsewhere. */
export type SelectListElement = HTMLElement & { sync(): void };

export function selectList<T>(o: SelectListOptions<T>): SelectListElement {
  const order = o.items.map(o.id);
  const byId = new Map(o.items.map((t) => [o.id(t), t]));
  // Forget selected items that are no longer listed.
  const kept = o.selection.inOrder(order);
  if (kept.length !== o.selection.ids.peek().size) o.selection.set(kept);
  let focused = kept[0] ?? order[0] ?? null;
  const rows = new Map<string, HTMLElement>();
  const selecting = () => !!o.mode?.peek();
  const sync = () => {
    list.classList.toggle("selecting", selecting());
    const s = o.selection.ids.peek();
    for (const [id, li] of rows) {
      li.setAttribute("aria-selected", String(s.has(id)));
      li.classList.toggle("selected", s.has(id));
      li.tabIndex = id === focused ? 0 : -1;
    }
  };
  const focus = (id: string | undefined) => {
    if (!id) return;
    focused = id;
    sync();
    rows.get(id)?.focus();
  };
  const menuFor = (id: string, at: Point) => {
    const ids = o.selection.forMenu(id, order);
    sync();
    o.menu(ids.map((x) => byId.get(x)!), at);
  };
  const row = (t: T) => {
    const id = o.id(t);
    const li = h("li", { role: "option", "aria-selected": "false", tabindex: "-1", dataset: { id } }, h("span", { class: "select-check", "aria-hidden": "true" }), o.render(t));
    li.addEventListener("click", (e) => {
      // Buttons inside an item (Restore…) do their own thing.
      if ((e.target as HTMLElement).closest("button")) return;
      focused = id;
      const plain = o.selection.click(id, order, { meta: e.metaKey || e.ctrlKey || selecting(), shift: e.shiftKey });
      sync();
      if (plain && !selecting()) o.open(t);
    });
    li.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      focused = id;
      menuFor(id, { x: e.clientX, y: e.clientY });
    });
    li.addEventListener("keydown", (e) => {
      if (e.target !== li) return;
      const i = order.indexOf(id);
      const move = (to: string | undefined) => {
        if (!to) return;
        if (e.shiftKey) o.selection.extendTo(to, order);
        focus(to);
      };
      if (isMenuKey(e)) menuFor(id, menuPointFor(li));
      else if (e.key === "ArrowDown") move(order[i + 1]);
      else if (e.key === "ArrowUp") move(order[i - 1]);
      else if (e.key === "Home") move(order[0]);
      else if (e.key === "End") move(order[order.length - 1]);
      else if (e.key === "Enter" && !selecting()) o.open(t);
      else if (e.key === " " && selecting()) {
        o.selection.click(id, order, { meta: true, shift: false });
        sync();
      }
      // With select mode, the page handles ⌘A and Escape (turning the mode on and off).
      else if (!o.mode && e.key === "a" && e.metaKey) {
        o.selection.set(order, id);
        sync();
      } else if (!o.mode && e.key === "Escape" && o.selection.ids.peek().size > 1) {
        o.selection.set([id], id);
        sync();
      } else return;
      e.preventDefault();
      e.stopPropagation();
    });
    rows.set(id, li);
    return li;
  };
  const list = h("ul", { class: `select-list ${o.className ?? ""}`, role: "listbox", "aria-label": o.label, "aria-multiselectable": "true" }, o.items.map(row));
  const out = Object.assign(list, { sync });
  sync();
  return out;
}
