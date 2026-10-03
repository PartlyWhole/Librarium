/**
 * A list whose items can be opened and selected several at a time (the APG listbox pattern,
 * multi-selectable): a click opens an item, ⌘-click and ⇧-click select; ↑/↓ move, ⇧↑/⇧↓ extend
 * the selection, Return opens, ⌘A selects all, Escape leaves one; right-click, the menu key or
 * ⇧F10 offer the selected items' menu.
 */
import { h, type Child } from "./dom";
import { isMenuKey, menuPointFor } from "./menu";
import type { Selection } from "./selection";

export interface SelectListOptions<T> {
  label: string;
  items: T[];
  id(t: T): string;
  render(t: T): Child;
  open(t: T): void;
  menu(ts: T[], at: { x: number; y: number }): void;
  selection: Selection;
  className?: string;
}

export function selectList<T>(o: SelectListOptions<T>): HTMLElement {
  const order = o.items.map(o.id);
  const byId = new Map(o.items.map((t) => [o.id(t), t]));
  // Forget selected items that are no longer listed.
  const kept = o.selection.inOrder(order);
  if (kept.length !== o.selection.ids.peek().size) o.selection.set(kept);
  let focused = kept[0] ?? order[0] ?? null;
  const rows = new Map<string, HTMLElement>();
  const sync = () => {
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
  const menuFor = (id: string, at: { x: number; y: number }) => {
    const ids = o.selection.forMenu(id, order);
    sync();
    o.menu(ids.map((x) => byId.get(x)!).filter(Boolean), at);
  };
  const list = h("ul", { class: `select-list ${o.className ?? ""}`, role: "listbox", "aria-label": o.label, "aria-multiselectable": "true" },
    o.items.map((t) => {
      const id = o.id(t);
      const li = h("li", { role: "option", "aria-selected": "false", tabindex: "-1", dataset: { id } }, o.render(t));
      li.addEventListener("click", (e) => {
        // Buttons inside an item (Restore…) do their own thing.
        if ((e.target as HTMLElement).closest("button")) return;
        focused = id;
        const plain = o.selection.click(id, order, { meta: e.metaKey || e.ctrlKey, shift: e.shiftKey });
        sync();
        if (plain) o.open(t);
      });
      li.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        focused = id;
        menuFor(id, { x: e.clientX, y: e.clientY });
      });
      li.addEventListener("keydown", (e) => {
        if (e.target !== li) return;
        const i = order.indexOf(id);
        if (isMenuKey(e)) {
          e.preventDefault();
          menuFor(id, menuPointFor(li));
          return;
        }
        const move = (to: string | undefined) => {
          if (!to) return;
          if (e.shiftKey) o.selection.extendTo(to, order);
          focus(to);
        };
        if (e.key === "ArrowDown") move(order[i + 1]);
        else if (e.key === "ArrowUp") move(order[i - 1]);
        else if (e.key === "Home") move(order[0]);
        else if (e.key === "End") move(order[order.length - 1]);
        else if (e.key === "Enter") o.open(t);
        else if (e.key === "a" && (e.metaKey || e.ctrlKey)) {
          o.selection.set(order, id);
          sync();
        } else if (e.key === "Escape" && o.selection.ids.peek().size > 1) {
          o.selection.set([id], id);
          sync();
        } else return;
        e.preventDefault();
        e.stopPropagation();
      });
      rows.set(id, li);
      return li;
    }),
  );
  sync();
  return list;
}
