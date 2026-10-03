/**
 * The WAI-ARIA APG tree pattern: one tab stop (roving tabindex), arrow keys to move,
 * Right/Left to expand/collapse, Home/End, Enter to activate, type-ahead. No buttons in rows.
 *
 * Virtualized: rows are flat `treeitem`s carrying aria-level/setsize/posinset (a form the APG
 * allows), and only the rows in view are in the DOM, so 10,000 notes stay fast.
 *
 * Items (rows without children) can be selected several at a time: ⌘-click, ⇧-click, ⇧↑/⇧↓.
 */
import { isMenuKey, menuPointFor } from "./menu";
import { Selection } from "./selection";
import { h } from "./dom";
import { icon, type IconNode } from "./icon";
import { dragSource, dropTarget, type DragPayload, type DropTarget } from "./dnd";

export interface TreeNode {
  id: string;
  label: string;
  icon?: IconNode;
  children?: TreeNode[];
  expanded?: boolean;
  /** Folded until the user unfolds it (instead of open until folded). */
  startCollapsed?: boolean;
  /** A calm placeholder line ("No notes yet"), shown but not focusable. */
  placeholder?: boolean;
  current?: boolean;
  /** For a row with children too: a click opens it, and only the arrow folds it. */
  onActivate?: () => void;
  /** Opens it in a new tab (a middle-click). */
  onOpenNew?: () => void;
  /** The row's own context menu (instead of the tree's). */
  onContext?: (at: { x: number; y: number }) => void;
  /** What dragging this row carries (with others selected, theirs too). */
  drag?: () => DragPayload;
  /** Things can be dropped on this row. */
  drop?: DropTarget;
}

interface Flat {
  node: TreeNode;
  level: number;
  parent: TreeNode | null;
  pos: number;
  size: number;
}

export const ROW = 26;
const OVERSCAN = 20;

export class Tree {
  readonly el: HTMLDivElement;
  private flat: Flat[] = [];
  private focusedId: string | null = null;
  private typeahead = "";
  private typeaheadTimer: ReturnType<typeof setTimeout> | undefined;
  private scroller: HTMLElement | null = null;
  private onScroll = () => this.paint();
  /** Asked for a context menu for these items (right-click, the menu key or ⇧F10). */
  onContext: ((ids: string[], at: { x: number; y: number }) => void) | null = null;
  /** The selected items. */
  readonly selection = new Selection();

  constructor(label: string, private onToggle: (id: string, expanded: boolean) => void) {
    this.el = h("div", { class: "tree", role: "tree", "aria-label": label, "aria-multiselectable": "true" });
    this.el.addEventListener("keydown", (e) => this.key(e));
    // Rows that carry something can be dragged (with the others selected, if it is one).
    dragSource(this.el, (t) => {
      const id = t.closest<HTMLElement>("[role=treeitem]")?.dataset.id;
      const n = this.flat.find((f) => f.node.id === id)?.node;
      if (!n?.drag) return null;
      const sel = this.selection.ids.peek();
      const nodes = sel.has(n.id) && sel.size > 1 ? this.flat.filter((f) => sel.has(f.node.id) && f.node.drag).map((f) => f.node) : [n];
      const ps = nodes.map((x) => x.drag!());
      const kinds = new Set(ps.map((p) => p.kind));
      return { payload: { records: ps.flatMap((p) => p.records), folders: ps.flatMap((p) => p.folders), kind: kinds.size === 1 ? [...kinds][0]! : "" }, label: n.label };
    });
    this.el.addEventListener("focusin", (e) => {
      const it = (e.target as HTMLElement).closest<HTMLElement>("[role=treeitem]");
      if (it?.dataset.id) this.focusedId = it.dataset.id;
    });
  }

  render(nodes: TreeNode[]): void {
    const scroller = this.el.parentElement;
    if (scroller !== this.scroller) {
      this.scroller?.removeEventListener("scroll", this.onScroll);
      this.scroller = scroller;
      scroller?.addEventListener("scroll", this.onScroll, { passive: true });
    }
    this.flat = [];
    const walk = (list: TreeNode[], level: number, parent: TreeNode | null) => {
      list.forEach((n, i) => {
        this.flat.push({ node: n, level, parent, pos: i + 1, size: list.length });
        if (n.children && n.expanded) walk(n.children, level + 1, n);
      });
    };
    walk(nodes, 1, null);
    if (!this.flat.some((f) => f.node.id === this.focusedId && !f.node.placeholder)) {
      this.focusedId = this.flat.find((f) => !f.node.placeholder)?.node.id ?? null;
    }
    this.el.style.height = `${this.flat.length * ROW}px`;
    this.paint();
  }

  /** Renders the rows in view (and the focused row, wherever it is). */
  private paint(): void {
    const hadFocus = this.el.contains(document.activeElement);
    const top = this.scroller ? this.scroller.scrollTop - this.el.offsetTop : 0;
    const height = this.scroller?.clientHeight || 60 * ROW;
    const first = Math.max(0, Math.floor(top / ROW) - OVERSCAN);
    const last = Math.min(this.flat.length, Math.ceil((top + height) / ROW) + OVERSCAN);
    const idx = new Set<number>();
    for (let i = first; i < last; i++) idx.add(i);
    const fi = this.flat.findIndex((f) => f.node.id === this.focusedId);
    if (fi >= 0) idx.add(fi);
    const rows = [...idx].sort((a, b) => a - b).map((i) => this.row(this.flat[i]!, i));
    this.el.replaceChildren(...rows);
    if (hadFocus) this.el.querySelector<HTMLElement>(`[data-index="${fi}"]`)?.focus({ preventScroll: true });
  }

  private row(f: Flat, i: number): HTMLElement {
    const n = f.node;
    const hasChildren = !!n.children;
    const item = !hasChildren && !n.placeholder;
    const selected = item && this.selection.ids.peek().has(n.id);
    const el = h("div", {
      role: n.placeholder ? "none" : "treeitem",
      class: `tree-item ${n.placeholder ? "placeholder" : ""} ${n.current ? "current" : ""} ${selected ? "selected" : ""} level-${Math.min(f.level, 2)}`,
      "aria-selected": item ? String(selected) : undefined,
      "aria-level": n.placeholder ? undefined : String(f.level),
      "aria-setsize": n.placeholder ? undefined : String(f.size),
      "aria-posinset": n.placeholder ? undefined : String(f.pos),
      "aria-expanded": hasChildren ? String(!!n.expanded) : undefined,
      "aria-current": n.current ? "page" : undefined,
      tabindex: n.placeholder ? undefined : n.id === this.focusedId ? "0" : "-1",
      style: { top: `${i * ROW}px`, paddingLeft: `${8 + (f.level - 1) * 14}px` },
      dataset: { id: n.id, index: String(i) },
    },
      hasChildren ? h("span", { class: `tree-twisty ${n.expanded ? "open" : ""} ${n.children!.length ? "" : "leafless"}`, "aria-hidden": "true" }) : h("span", { class: "tree-spacer" }),
      n.icon ? icon(n.icon, 15) : null,
      h("span", { class: "tree-label" }, n.label),
    );
    if (!n.placeholder) {
      el.addEventListener("click", (e) => {
        if (hasChildren) {
          this.focus(i);
          const onTwisty = (e.target as HTMLElement).closest(".tree-twisty");
          if (n.onActivate && !onTwisty) n.onActivate();
          else this.onToggle(n.id, !n.expanded);
          return;
        }
        const plain = this.selection.click(n.id, this.items(), { meta: e.metaKey || e.ctrlKey, shift: e.shiftKey });
        this.focus(i);
        if (plain) n.onActivate?.();
      });
      if (n.drop) dropTarget(el, n.drop);
      if (n.onOpenNew) {
        el.addEventListener("mousedown", (e) => e.button === 1 && e.preventDefault());
        el.addEventListener("auxclick", (e) => {
          if (e.button !== 1) return;
          e.preventDefault();
          n.onOpenNew!();
        });
      }
      el.addEventListener("contextmenu", (e) => {
        if (n.onContext) {
          e.preventDefault();
          this.focusedId = n.id;
          el.focus({ preventScroll: true });
          n.onContext({ x: e.clientX, y: e.clientY });
          return;
        }
        if (!this.onContext) return;
        e.preventDefault();
        const ids = item ? this.selection.forMenu(n.id, this.items()) : [n.id];
        this.focusedId = n.id;
        this.markSelection();
        el.focus({ preventScroll: true });
        this.onContext(ids, { x: e.clientX, y: e.clientY });
      });
    }
    return el;
  }

  /** Updates the selected rows' marks without rebuilding them. */
  private markSelection(): void {
    const s = this.selection.ids.peek();
    for (const el of this.el.querySelectorAll<HTMLElement>("[role=treeitem]")) {
      if (el.getAttribute("aria-selected") === null) continue;
      const on = s.has(el.dataset.id ?? "");
      el.setAttribute("aria-selected", String(on));
      el.classList.toggle("selected", on);
    }
  }

  /** The selectable items, in order. */
  private items(): string[] {
    return this.flat.filter((f) => !f.node.children && !f.node.placeholder).map((f) => f.node.id);
  }

  private focus(i: number): void {
    const f = this.flat[i];
    if (!f) return;
    this.focusedId = f.node.id;
    if (this.scroller) {
      const y = this.el.offsetTop + i * ROW;
      if (y < this.scroller.scrollTop) this.scroller.scrollTop = y;
      else if (y + ROW > this.scroller.scrollTop + this.scroller.clientHeight) this.scroller.scrollTop = y + ROW - this.scroller.clientHeight;
    }
    this.paint();
    this.el.querySelector<HTMLElement>(`[data-index="${i}"]`)?.focus({ preventScroll: true });
  }

  private key(e: KeyboardEvent): void {
    if (e.isComposing || e.metaKey || e.ctrlKey || e.altKey) return;
    if (isMenuKey(e) && this.focusedId) {
      const it = [...this.el.querySelectorAll<HTMLElement>("[role=treeitem]")].find((x) => x.dataset.id === this.focusedId);
      const own = this.flat.find((f) => f.node.id === this.focusedId)?.node.onContext;
      if (it && own) {
        e.preventDefault();
        own(menuPointFor(it));
        return;
      }
      if (it && this.onContext) {
        e.preventDefault();
        const isItem = this.items().includes(this.focusedId);
        const ids = isItem ? this.selection.forMenu(this.focusedId, this.items()) : [this.focusedId];
        // Mark the rows in place: the menu gives focus back to this very row.
        this.markSelection();
        this.onContext(ids, menuPointFor(it));
        return;
      }
    }
    const vis = this.flat.map((f, i) => ({ f, i })).filter((x) => !x.f.node.placeholder);
    const k = vis.findIndex((x) => x.f.node.id === this.focusedId);
    const cur = vis[k];
    if (!cur) return;
    const go = (x: { i: number } | undefined) => x && this.focus(x.i);
    const n = cur.f.node;
    // ⇧↑/⇧↓ extend the selection over items.
    const extend = (x: { f: Flat; i: number } | undefined) => {
      if (!x) return;
      const items = this.items();
      if (items.includes(n.id) && this.selection.ids.peek().size === 0) this.selection.set([n.id], n.id);
      if (items.includes(x.f.node.id)) this.selection.extendTo(x.f.node.id, items);
      go(x);
    };
    switch (e.key) {
      case "ArrowDown":
        if (e.shiftKey) extend(vis[k + 1]);
        else go(vis[k + 1]);
        break;
      case "ArrowUp":
        if (e.shiftKey) extend(vis[k - 1]);
        else go(vis[k - 1]);
        break;
      case "Escape":
        if (this.selection.ids.peek().size <= 1) return;
        this.selection.set(this.items().includes(n.id) ? [n.id] : [], n.id);
        this.paint();
        break;
      case "Home":
        go(vis[0]);
        break;
      case "End":
        go(vis[vis.length - 1]);
        break;
      case "ArrowRight":
        if (n.children) {
          if (!n.expanded) this.onToggle(n.id, true);
          else if (vis[k + 1]?.f.parent === n) go(vis[k + 1]);
        }
        break;
      case "ArrowLeft":
        if (n.children && n.expanded) this.onToggle(n.id, false);
        else if (cur.f.parent) go(vis.find((x) => x.f.node === cur.f.parent));
        break;
      case "Enter":
        if (n.children && n.onActivate) n.onActivate();
        else if (n.children) this.onToggle(n.id, !n.expanded);
        else n.onActivate?.();
        break;
      default:
        if (e.key.length === 1 && /\S/.test(e.key)) {
          clearTimeout(this.typeaheadTimer);
          this.typeahead += e.key.toLowerCase();
          this.typeaheadTimer = setTimeout(() => (this.typeahead = ""), 600);
          const order = [...vis.slice(k + 1), ...vis.slice(0, k + 1)];
          go(order.find((x) => x.f.node.label.toLowerCase().startsWith(this.typeahead)));
          break;
        }
        return;
    }
    e.preventDefault();
  }
}
