/**
 * Multiple selection in a list, as on the Mac: a click selects one item (and opens it), ⌘-click
 * adds or removes an item, ⇧-click selects the range from the last item clicked; ⇧↑/⇧↓ extend it
 * from the keyboard, ⌘A selects all, Escape leaves only the focused item.
 */
import { signal } from "./signal";

export class Selection {
  readonly ids = signal<ReadonlySet<string>>(new Set());
  private anchor: string | null = null;

  has(id: string): boolean {
    return this.ids().has(id);
  }

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

  /**
   * Applies a click on `id` in a list of `order`. Returns true when it was a plain click (the
   * item should open), false when it only changed the selection.
   */
  click(id: string, order: readonly string[], mods: { meta: boolean; shift: boolean }): boolean {
    if (mods.shift && this.anchor && order.includes(this.anchor)) {
      this.ids.set(new Set(range(order, this.anchor, id)));
      return false;
    }
    if (mods.meta) {
      const s = new Set(this.ids.peek());
      if (s.has(id)) s.delete(id);
      else s.add(id);
      this.ids.set(s);
      this.anchor = id;
      return false;
    }
    this.ids.set(new Set([id]));
    this.anchor = id;
    return true;
  }

  /** ⇧↑/⇧↓: extends the selection from the anchor to `to`. */
  extendTo(to: string, order: readonly string[]): void {
    if (!this.anchor || !order.includes(this.anchor)) this.anchor = to;
    this.ids.set(new Set(range(order, this.anchor, to)));
  }

  /** The records a context menu acts on: the selection when `id` is in it, else just `id`. */
  forMenu(id: string, order: readonly string[]): string[] {
    if (this.ids.peek().has(id) && this.ids.peek().size > 1) return this.inOrder(order);
    this.ids.set(new Set([id]));
    this.anchor = id;
    return [id];
  }
}

function range(order: readonly string[], a: string, b: string): string[] {
  const i = order.indexOf(a);
  const j = order.indexOf(b);
  if (i < 0 || j < 0) return [b];
  return order.slice(Math.min(i, j), Math.max(i, j) + 1);
}
