/**
 * Undo for app actions (rename, move, archive, restore): each records an inverse that expects
 * the version it produced, and refuses if the file has changed since. Toasts offer Undo.
 * Text undo is the editor's own history.
 */
import { toast } from "../kit/toast";
import { signal } from "../kit/signal";

export interface Undoable {
  label: string;
  undo(): Promise<void>;
}

export class Undo {
  readonly last = signal<Undoable | null>(null);

  /** Records an action that was just done, and offers to undo it. */
  done(message: string, u: Undoable): void {
    this.last.set(u);
    toast(message, { action: { label: "Undo", run: () => void this.undoLast() } });
  }

  async undoLast(): Promise<void> {
    const u = this.last.peek();
    if (!u) return;
    this.last.set(null);
    try {
      await u.undo();
      toast(`Undone: ${u.label}`);
    } catch (e) {
      toast(e && typeof e === "object" && "message" in e ? String((e as { message: unknown }).message) : "That can’t be undone any more.");
    }
  }
}
