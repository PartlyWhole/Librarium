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

/** An app action in this session's log (kept in memory only), newest last. */
export interface UndoEntry {
  message: string;
  label: string;
  at: number;
  /** "latest": Undo would undo it; "replaced": a later action took its place (one level). */
  state: "latest" | "replaced" | "undone" | "failed";
  error?: string;
}

export class Undo {
  readonly last = signal<Undoable | null>(null);
  /** What was done this session, for the Undo history view. */
  readonly log = signal<readonly UndoEntry[]>([]);
  private entries = new Map<Undoable, UndoEntry>();

  /** Records an action that was just done, and offers to undo it. */
  done(message: string, u: Undoable): void {
    this.last.set(u);
    const entry: UndoEntry = { message, label: u.label, at: Date.now(), state: "latest" };
    this.entries.clear();
    this.entries.set(u, entry);
    this.log.set([...this.log.peek().map((e) => (e.state === "latest" ? { ...e, state: "replaced" as const } : e)), entry].slice(-100));
    toast(message, { action: { label: "Undo", run: () => void this.undoLast() } });
  }

  async undoLast(): Promise<void> {
    const u = this.last.peek();
    if (!u) return;
    this.last.set(null);
    try {
      await u.undo();
      this.settle(u, "undone");
      toast(`Undone: ${u.label}`);
    } catch (e) {
      const message = e && typeof e === "object" && "message" in e ? String((e as { message: unknown }).message) : "That can’t be undone any more.";
      this.settle(u, "failed", message);
      toast(message);
    }
  }

  private settle(u: Undoable, state: UndoEntry["state"], error?: string): void {
    const entry = this.entries.get(u);
    if (!entry) return;
    this.entries.delete(u);
    this.log.set(this.log.peek().map((e) => (e === entry ? { ...e, state, ...(error ? { error } : {}) } : e)));
  }
}
