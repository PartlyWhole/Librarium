/**
 * The WAI-ARIA APG tree pattern: one tab stop (roving tabindex), ↑/↓ to move, →/← to unfold,
 * fold or go to the parent, Home/End, Enter to activate, type-ahead. No buttons in rows.
 *
 * Virtualised: rows are flat `treeitem`s carrying aria-level/setsize/posinset (a form the APG
 * allows), and only the rows in view are in the DOM, so 10,000 notes stay fast.
 *
 * Leaves can be selected several at a time: ⌘-click, ⇧-click, ⇧↑/⇧↓.
 */
import { isMenuKey, menuPointFor, type Point } from "./menu";
import { Selection } from "./selectlist";
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
  /** A calm placeholder line ("No notes yet."), shown but not focusable. */
  placeholder?: boolean;
  current?: boolean;
  /** For a row with children too: a click opens it, and only the arrow folds it. */
  onActivate?: () => void;
  /** Opens it in a new tab (a middle-click). */
  onOpenNew?: () => void;
  /** The row's own context menu (instead of the tree's). */
  onContext?: (at: Point) => void;
  /** What dragging this row carries (with others selected, theirs too). */
  drag?: () => DragPayload;
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
  readonly selection = new Selection();
  /** Asked for a context menu for these leaves (right-click, the menu key or ⇧F10). */
  onContext: ((ids: string[], at: Point) => void) | null = null;
  private flat: Flat[] = [];
  private focusedId: string | null = null;
  private typed = "";
  private typedTimer: ReturnType<typeof setTimeout> | undefined;
  private scroller: HTMLElement | null = null;
  private onScroll = () => this.paint();

  constructor(label: string, private onToggle: (id: string, expanded: boolean) => void) {
    this.el = h("div", { class: "tree", role: "tree", "aria-label": label, "aria-multiselectable": "true" });
    this.el.addEventListener("keydown", (e) => this.key(e));
    this.el.addEventListener("focusin", (e) => {
      const id = (e.target as HTMLElement).closest<HTMLElement>("[role=treeitem]")?.dataset.id;
      if (id) this.focusedId = id;
    });
    // Rows that carry something can be dragged (with the others selected, if it is one).
    dragSource(this.el, (t) => {
      const id = t.closest<HTMLElement>("[role=treeitem]")?.dataset.id;
      const n = this.flat.find((f) => f.node.id === id)?.node;
      if (!n?.drag) return null;
      const sel = this.selection.ids.peek();
      const nodes = sel.has(n.id) && sel.size > 1 ? this.flat.map((f) => f.node).filter((x) => sel.has(x.id) && x.drag) : [n];
      const ps = nodes.map((x) => x.drag!());
      const kinds = new Set(ps.map((p) => p.kind));
      return { payload: { records: ps.flatMap((p) => p.records), folders: ps.flatMap((p) => p.folders), kind: kinds.size === 1 ? [...kinds][0]! : "" }, label: n.label };
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
    const walk = (list: TreeNode[], level: number, parent: TreeNode | null) =>
      list.forEach((n, i) => {
        this.flat.push({ node: n, level, parent, pos: i + 1, size: list.length });
        if (n.children && n.expanded) walk(n.children, level + 1, n);
      });
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
    this.el.replaceChildren(...[...idx].sort((a, b) => a - b).map((i) => this.row(this.flat[i]!, i)));
    if (hadFocus) this.rowEl(fi)?.focus({ preventScroll: true });
  }

  private rowEl(i: number): HTMLElement | null {
    return this.el.querySelector<HTMLElement>(`[data-index="${i}"]`);
  }

  private row(f: Flat, i: number): HTMLElement {
    const n = f.node;
    const folder = !!n.children;
    const leaf = !folder && !n.placeholder;
    const selected = leaf && this.selection.ids.peek().has(n.id);
    const el = h("div", {
      role: n.placeholder ? "none" : "treeitem",
      class: `tree-item level-${Math.min(f.level, 2)}${n.placeholder ? " placeholder" : ""}${n.current ? " current" : ""}${selected ? " selected" : ""}`,
      "aria-selected": leaf ? String(selected) : undefined,
      "aria-level": n.placeholder ? undefined : String(f.level),
      "aria-setsize": n.placeholder ? undefined : String(f.size),
      "aria-posinset": n.placeholder ? undefined : String(f.pos),
      "aria-expanded": folder ? String(!!n.expanded) : undefined,
      "aria-current": n.current ? "page" : undefined,
      tabindex: n.placeholder ? undefined : n.id === this.focusedId ? "0" : "-1",
      style: { top: `${i * ROW}px`, paddingLeft: `${8 + (f.level - 1) * 14}px` },
      dataset: { id: n.id, index: String(i) },
    },
      folder ? h("span", { class: `tree-twisty${n.expanded ? " open" : ""}${n.children!.length ? "" : " leafless"}`, "aria-hidden": "true" }) : h("span", { class: "tree-spacer" }),
      n.icon ? icon(n.icon, 15) : null,
      h("span", { class: "tree-label" }, n.label),
    );
    if (n.placeholder) return el;
    el.addEventListener("click", (e) => {
      if (folder) {
        this.focus(i);
        if (n.onActivate && !(e.target as HTMLElement).closest(".tree-twisty")) n.onActivate();
        else this.onToggle(n.id, !n.expanded);
        return;
      }
      const plain = this.selection.click(n.id, this.leaves(), { meta: e.metaKey, shift: e.shiftKey });
      this.focus(i);
      if (plain) n.onActivate?.();
    });
    if (n.drop) dropTarget(el, n.drop);
    if (n.onOpenNew) {
      el.addEventListener("mousedown", (e) => e.button === 1 && e.preventDefault());
      el.addEventListener("auxclick", (e) => e.button === 1 && (e.preventDefault(), n.onOpenNew!()));
    }
    el.addEventListener("contextmenu", (e) => {
      if (!n.onContext && !this.onContext) return;
      e.preventDefault();
      this.focusedId = n.id;
      el.focus({ preventScroll: true });
      this.menu(n, leaf, { x: e.clientX, y: e.clientY });
    });
    return el;
  }

  /** Opens a row's own menu, or the tree's for the selected leaves. */
  private menu(n: TreeNode, leaf: boolean, at: Point): void {
    if (n.onContext) return n.onContext(at);
    const ids = leaf ? this.selection.forMenu(n.id, this.leaves()) : [n.id];
    // Marked in place: the menu gives focus back to this very row.
    this.markSelection();
    this.onContext?.(ids, at);
  }

  /** Updates the selected rows' marks without rebuilding them. */
  private markSelection(): void {
    const s = this.selection.ids.peek();
    for (const el of this.el.querySelectorAll<HTMLElement>("[aria-selected]")) {
      const on = s.has(el.dataset.id ?? "");
      el.setAttribute("aria-selected", String(on));
      el.classList.toggle("selected", on);
    }
  }

  /** The selectable leaves, in order. */
  private leaves(): string[] {
    return this.flat.filter((f) => !f.node.children && !f.node.placeholder).map((f) => f.node.id);
  }

  private focus(i: number): void {
    const f = this.flat[i];
    if (!f) return;
    this.focusedId = f.node.id;
    const s = this.scroller;
    if (s) {
      const y = this.el.offsetTop + i * ROW;
      if (y < s.scrollTop) s.scrollTop = y;
      else if (y + ROW > s.scrollTop + s.clientHeight) s.scrollTop = y + ROW - s.clientHeight;
    }
    this.paint();
    this.rowEl(i)?.focus({ preventScroll: true });
  }

  private key(e: KeyboardEvent): void {
    if (e.isComposing || e.metaKey || e.ctrlKey || e.altKey) return;
    const vis = this.flat.map((f, i) => ({ f, i })).filter((x) => !x.f.node.placeholder);
    const k = vis.findIndex((x) => x.f.node.id === this.focusedId);
    const cur = vis[k];
    if (!cur) return;
    const n = cur.f.node;
    const leaves = this.leaves();
    const go = (x: { i: number } | undefined) => x && this.focus(x.i);
    // ⇧↑/⇧↓ extend the selection over leaves.
    const step = (x: { f: Flat; i: number } | undefined) => {
      if (!x) return;
      if (e.shiftKey) {
        if (leaves.includes(n.id) && this.selection.ids.peek().size === 0) this.selection.set([n.id], n.id);
        if (leaves.includes(x.f.node.id)) this.selection.extendTo(x.f.node.id, leaves);
      }
      go(x);
    };
    if (isMenuKey(e)) {
      const el = this.rowEl(cur.i);
      if (el) this.menu(n, leaves.includes(n.id), menuPointFor(el));
    } else if (e.key === "ArrowDown") step(vis[k + 1]);
    else if (e.key === "ArrowUp") step(vis[k - 1]);
    else if (e.key === "Home") go(vis[0]);
    else if (e.key === "End") go(vis[vis.length - 1]);
    else if (e.key === "Escape") {
      if (this.selection.ids.peek().size <= 1) return;
      this.selection.set(leaves.includes(n.id) ? [n.id] : [], n.id);
      this.paint();
    } else if (e.key === "ArrowRight") {
      if (n.children && !n.expanded) this.onToggle(n.id, true);
      else if (n.children && vis[k + 1]?.f.parent === n) go(vis[k + 1]);
    } else if (e.key === "ArrowLeft") {
      if (n.children && n.expanded) this.onToggle(n.id, false);
      else if (cur.f.parent) go(vis.find((x) => x.f.node === cur.f.parent));
    } else if (e.key === "Enter") {
      if (n.children && !n.onActivate) this.onToggle(n.id, !n.expanded);
      else n.onActivate?.();
    } else if (e.key.length === 1 && /\S/.test(e.key)) {
      clearTimeout(this.typedTimer);
      this.typed += e.key.toLowerCase();
      this.typedTimer = setTimeout(() => (this.typed = ""), 600);
      go([...vis.slice(k + 1), ...vis.slice(0, k + 1)].find((x) => x.f.node.label.toLowerCase().startsWith(this.typed)));
    } else return;
    e.preventDefault();
  }
}
