/**
 * The WAI-ARIA APG tree pattern: one tab stop (roving tabindex), arrow keys to move,
 * Right/Left to expand/collapse, Home/End, Enter to activate, type-ahead. No buttons in rows.
 *
 * Virtualized: rows are flat `treeitem`s carrying aria-level/setsize/posinset (a form the APG
 * allows), and only the rows in view are in the DOM, so 10,000 notes stay fast.
 */
import { h } from "./dom";
import { icon, type IconNode } from "./icon";

export interface TreeNode {
  id: string;
  label: string;
  icon?: IconNode;
  children?: TreeNode[];
  expanded?: boolean;
  /** A calm placeholder line ("No notes yet"), shown but not focusable. */
  placeholder?: boolean;
  current?: boolean;
  onActivate?: () => void;
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

  constructor(label: string, private onToggle: (id: string, expanded: boolean) => void) {
    this.el = h("div", { class: "tree", role: "tree", "aria-label": label });
    this.el.addEventListener("keydown", (e) => this.key(e));
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
    const el = h("div", {
      role: n.placeholder ? "none" : "treeitem",
      class: `tree-item ${n.placeholder ? "placeholder" : ""} ${n.current ? "current" : ""} level-${Math.min(f.level, 2)}`,
      "aria-level": n.placeholder ? undefined : String(f.level),
      "aria-setsize": n.placeholder ? undefined : String(f.size),
      "aria-posinset": n.placeholder ? undefined : String(f.pos),
      "aria-expanded": hasChildren ? String(!!n.expanded) : undefined,
      "aria-current": n.current ? "page" : undefined,
      tabindex: n.placeholder ? undefined : n.id === this.focusedId ? "0" : "-1",
      style: { top: `${i * ROW}px`, paddingLeft: `${8 + (f.level - 1) * 14}px` },
      dataset: { id: n.id, index: String(i) },
    },
      hasChildren ? h("span", { class: `tree-twisty ${n.expanded ? "open" : ""}`, "aria-hidden": "true" }) : h("span", { class: "tree-spacer" }),
      n.icon ? icon(n.icon, 15) : null,
      h("span", { class: "tree-label" }, n.label),
    );
    if (!n.placeholder) {
      el.addEventListener("click", () => {
        this.focus(i);
        if (hasChildren) this.onToggle(n.id, !n.expanded);
        else n.onActivate?.();
      });
    }
    return el;
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
    const vis = this.flat.map((f, i) => ({ f, i })).filter((x) => !x.f.node.placeholder);
    const k = vis.findIndex((x) => x.f.node.id === this.focusedId);
    const cur = vis[k];
    if (!cur) return;
    const go = (x: { i: number } | undefined) => x && this.focus(x.i);
    const n = cur.f.node;
    switch (e.key) {
      case "ArrowDown":
        go(vis[k + 1]);
        break;
      case "ArrowUp":
        go(vis[k - 1]);
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
        if (n.children) this.onToggle(n.id, !n.expanded);
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
