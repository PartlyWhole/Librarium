/**
 * Undo and redo, kept per place for the session (decision 0060). Each place has its own history:
 *
 * - a record's page (`record:<id>`): a note's typing, interleaved with what was done to it on its
 *   page (renaming, moving, restoring a version); a capture's words, renaming and deleting;
 * - `library`: what is done in the sidebar, the Library, the Files and Captures pages and the
 *   archive (moving, renaming, archiving, folders).
 *
 * ⌘Z / ⇧⌘Z act on the place being looked at (text-undo.ts). Histories outlive leaving a page
 * while the app runs: a note's typing history is kept (as CodeMirror's JSON) and given back when
 * the note is opened again unchanged. App steps record how to undo and redo themselves; each
 * expects the versions it produced and refuses if the file has changed since (it is then
 * dropped). Typing is a marker in the place's history; CodeMirror holds the changes themselves.
 */
import { toast } from "../kit/toast";
import { computed, signal } from "../kit/signal";

export interface Undoable {
  label: string;
  undo(): Promise<void>;
  /** Does it again after an undo (without it, the step can't be redone). */
  redo?(): Promise<void>;
}

/** The text history of the editor showing a place (CodeMirror's, through editor.ts). */
export interface TextHistory {
  undo(): boolean;
  redo(): boolean;
  /** Typing after this starts a new step (so an app step isn't merged into typing). */
  isolate(): void;
}

export const LIBRARY = "library";
export const recordScope = (id: string) => `record:${id}`;

/** An app step, or a step of the editor showing the place (typing; a board's drawing). */
type Entry = { kind: "app"; step: Undoable; n: number } | { kind: "text"; label?: string };
interface Stacks {
  past: readonly Entry[];
  future: readonly Entry[];
}

/** How many steps each place keeps. */
const DEPTH = 100;
const EMPTY: Stacks = { past: [], future: [] };

const message = (e: unknown, otherwise = "That can’t be undone any more.") => (e && typeof e === "object" && "message" in e ? String((e as { message: unknown }).message) : otherwise);

export class Undo {
  private readonly stacks = signal<ReadonlyMap<string, Stacks>>(new Map());
  private readonly texts = new Map<string, { history: TextHistory; editor: unknown }>();
  private readonly kept = new Map<string, { json: unknown; body: string }>();
  private busy = false;
  private n = 0;
  /** The place an action being run belongs to (`within`). */
  private ambient: string | null = null;

  private get(scope: string): Stacks {
    return this.stacks.peek().get(scope) ?? EMPTY;
  }
  private put(scope: string, s: Stacks): void {
    const m = new Map(this.stacks.peek());
    if (s.past.length || s.future.length) m.set(scope, { past: s.past.slice(-DEPTH), future: s.future });
    else m.delete(scope);
    this.stacks.set(m);
  }

  /** Whether a place has something to undo / redo (reactive). */
  canUndo(scope: string): boolean {
    return (this.stacks().get(scope)?.past.length ?? 0) > 0;
  }
  canRedo(scope: string): boolean {
    return (this.stacks().get(scope)?.future.length ?? 0) > 0;
  }
  /** What ⌘Z would undo in a place: "Typing", or the step's label (for the Edit menu). */
  undoLabel(scope: string): string | null {
    const e = this.stacks().get(scope)?.past.at(-1);
    return !e ? null : e.kind === "text" ? (e.label ?? "Typing") : e.step.label;
  }
  redoLabel(scope: string): string | null {
    const e = this.stacks().get(scope)?.future.at(-1);
    return !e ? null : e.kind === "text" ? (e.label ?? "Typing") : e.step.label;
  }

  /** The latest app step anywhere, and the latest undone one (the Edit menu's "last" items). */
  private latest(which: "past" | "future"): { scope: string; entry: Entry & { kind: "app" } } | null {
    let best: { scope: string; entry: Entry & { kind: "app" } } | null = null;
    for (const [scope, s] of this.stacks()) {
      for (const e of s[which]) if (e.kind === "app" && (!best || e.n > best.entry.n)) best = { scope, entry: e };
    }
    return best;
  }
  readonly last = computed(() => this.latest("past")?.entry.step ?? null);
  readonly next = computed(() => this.latest("future")?.entry.step ?? null);

  /** Runs an action whose steps belong to `scope` (e.g. moving a note from its own page). */
  async within<T>(scope: string, run: () => Promise<T>): Promise<T> {
    const before = this.ambient;
    this.ambient = scope;
    try {
      return await run();
    } finally {
      this.ambient = before;
    }
  }

  /** Records an action that was just done, in its place's history, and offers to undo it. */
  done(message: string, u: Undoable, opts: { scope?: string } = {}): void {
    const scope = opts.scope ?? this.ambient ?? LIBRARY;
    const s = this.get(scope);
    this.put(scope, { past: [...s.past, { kind: "app", step: u, n: ++this.n }], future: [] });
    this.texts.get(scope)?.history.isolate();
    toast(message, { action: { label: "Undo", run: () => void this.undoStep(u) } });
  }

  /** The editor showing a place made a new history step (typing; "Drawing" on a board). */
  typed(scope: string, label?: string): void {
    const s = this.get(scope);
    this.put(scope, { past: [...s.past, label ? { kind: "text", label } : { kind: "text" }], future: [] });
  }

  /** The editor showing a place; returns how to let it go. */
  attachText(scope: string, history: TextHistory, editor: unknown): () => void {
    const mine = { history, editor };
    this.texts.set(scope, mine);
    return () => {
      if (this.texts.get(scope) === mine) this.texts.delete(scope);
    };
  }
  /** The place an editor belongs to, if it is attached to one. */
  scopeOf(editor: unknown): string | null {
    for (const [scope, t] of this.texts) if (t.editor === editor) return scope;
    return null;
  }

  /** Keeps a place's typing history (CodeMirror's JSON) for when it is opened again. */
  keepText(scope: string, json: unknown, body: string): void {
    this.kept.set(scope, { json, body });
  }
  /**
   * The kept typing history, if the text is still what it was; otherwise the typing steps are
   * forgotten (the file changed meanwhile), and the place's other steps stay.
   */
  takeText(scope: string, body: string): unknown {
    const k = this.kept.get(scope);
    this.kept.delete(scope);
    if (k && k.body === body) return k.json;
    const s = this.get(scope);
    if (s.past.some((e) => e.kind === "text") || s.future.some((e) => e.kind === "text")) {
      this.put(scope, { past: s.past.filter((e) => e.kind === "app"), future: s.future.filter((e) => e.kind === "app") });
    }
    return null;
  }

  /** Undoes the latest step of a place. */
  async undo(scope: string): Promise<void> {
    if (this.busy) return;
    const s = this.get(scope);
    const e = s.past.at(-1);
    if (!e) return;
    this.put(scope, { past: s.past.slice(0, -1), future: s.future });
    if (e.kind === "text") {
      // The editor's history may hold fewer steps (merged typing): then the next step is tried.
      if (this.texts.get(scope)?.history.undo()) this.put(scope, { ...this.get(scope), future: [...this.get(scope).future, e] });
      else return this.undo(scope);
      return;
    }
    await this.runUndo(scope, e);
  }

  /** Redoes the latest undone step of a place. */
  async redo(scope: string): Promise<void> {
    if (this.busy) return;
    const s = this.get(scope);
    const e = s.future.at(-1);
    if (!e) return;
    this.put(scope, { past: s.past, future: s.future.slice(0, -1) });
    if (e.kind === "text") {
      if (this.texts.get(scope)?.history.redo()) this.put(scope, { ...this.get(scope), past: [...this.get(scope).past, e] });
      else return this.redo(scope);
      return;
    }
    await this.runRedo(scope, e);
  }

  /** The most recent app step, wherever it was done (Edit ▸ Undo the last…, and tests). */
  async undoLast(): Promise<void> {
    const l = this.latest("past");
    if (l) await this.undoEntry(l.scope, l.entry);
  }
  async redoLast(): Promise<void> {
    const l = this.latest("future");
    if (!l || this.busy) return;
    const s = this.get(l.scope);
    this.put(l.scope, { past: s.past, future: s.future.filter((x) => x !== l.entry) });
    await this.runRedo(l.scope, l.entry);
  }

  /** A toast's Undo: that step, wherever it sits. */
  private async undoStep(u: Undoable): Promise<void> {
    for (const [scope, s] of this.stacks.peek()) {
      const e = s.past.find((x) => x.kind === "app" && x.step === u);
      if (e) return this.undoEntry(scope, e as Entry & { kind: "app" });
    }
  }
  private async undoEntry(scope: string, e: Entry & { kind: "app" }): Promise<void> {
    if (this.busy) return;
    const s = this.get(scope);
    this.put(scope, { past: s.past.filter((x) => x !== e), future: s.future });
    await this.runUndo(scope, e);
  }

  private async runUndo(scope: string, e: Entry & { kind: "app" }): Promise<void> {
    const u = e.step;
    this.busy = true;
    try {
      await u.undo();
      // Stamped again: the latest undone is redone first.
      e.n = ++this.n;
      if (u.redo) this.put(scope, { ...this.get(scope), future: [...this.get(scope).future, e] });
      toast(`Undone: ${u.label}`, u.redo ? { action: { label: "Redo", run: () => void this.redoEntry(scope, e) } } : {});
    } catch (err) {
      toast(message(err));
    } finally {
      this.busy = false;
    }
  }
  private async redoEntry(scope: string, e: Entry & { kind: "app" }): Promise<void> {
    if (this.busy) return;
    const s = this.get(scope);
    if (!s.future.includes(e)) return;
    this.put(scope, { past: s.past, future: s.future.filter((x) => x !== e) });
    await this.runRedo(scope, e);
  }
  private async runRedo(scope: string, e: Entry & { kind: "app" }): Promise<void> {
    const u = e.step;
    if (!u.redo) return;
    this.busy = true;
    try {
      await u.redo();
      e.n = ++this.n;
      this.put(scope, { ...this.get(scope), past: [...this.get(scope).past, e] });
      this.texts.get(scope)?.history.isolate();
      toast(`Redone: ${u.label}`, { action: { label: "Undo", run: () => void this.undoStep(u) } });
    } catch (err) {
      toast(message(err, "That can’t be done again any more."));
    } finally {
      this.busy = false;
    }
  }
}
