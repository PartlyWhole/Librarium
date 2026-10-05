/**
 * Undo and redo for app actions (moving, renaming, arranging, archiving, restoring), several
 * levels deep for the session. Each step records how to undo it and how to do it again; each
 * expects the versions it produced, and refuses if the file has changed since (the step is then
 * dropped). Toasts offer Undo. ⌘Z / ⇧⌘Z reach these when the focus isn't in text
 * (text-undo.ts); text undo is the editor's own history.
 */
import { toast } from "../kit/toast";
import { computed, signal } from "../kit/signal";

export interface Undoable {
  label: string;
  undo(): Promise<void>;
  /** Does it again after an undo (without it, the step can't be redone). */
  redo?(): Promise<void>;
}

/** How many steps are kept. */
const DEPTH = 50;

const message = (e: unknown, otherwise = "That can’t be undone any more.") => (e && typeof e === "object" && "message" in e ? String((e as { message: unknown }).message) : otherwise);

export class Undo {
  private readonly past = signal<readonly Undoable[]>([]);
  private readonly future = signal<readonly Undoable[]>([]);
  private busy = false;
  /** The step Undo would undo. */
  readonly last = computed(() => this.past().at(-1) ?? null);
  /** The step Redo would do again. */
  readonly next = computed(() => this.future().at(-1) ?? null);

  /** Records an action that was just done, and offers to undo it. */
  done(message: string, u: Undoable): void {
    this.past.set([...this.past.peek(), u].slice(-DEPTH));
    this.future.set([]);
    toast(message, { action: { label: "Undo", run: () => void this.undoLast() } });
  }

  async undoLast(): Promise<void> {
    const u = this.past.peek().at(-1);
    if (!u || this.busy) return;
    this.busy = true;
    this.past.set(this.past.peek().slice(0, -1));
    try {
      await u.undo();
      if (u.redo) this.future.set([...this.future.peek(), u]);
      toast(`Undone: ${u.label}`, u.redo ? { action: { label: "Redo", run: () => void this.redoLast() } } : {});
    } catch (e) {
      toast(message(e));
    } finally {
      this.busy = false;
    }
  }

  async redoLast(): Promise<void> {
    const u = this.future.peek().at(-1);
    if (!u?.redo || this.busy) return;
    this.busy = true;
    this.future.set(this.future.peek().slice(0, -1));
    try {
      await u.redo();
      this.past.set([...this.past.peek(), u].slice(-DEPTH));
      toast(`Redone: ${u.label}`, { action: { label: "Undo", run: () => void this.undoLast() } });
    } catch (e) {
      toast(message(e, "That can’t be done again any more."));
    } finally {
      this.busy = false;
    }
  }
}
