/**
 * Undo and redo, kept per place for the session (up to 100 steps each):
 * - a record's page (`record:<id>`): a note's typing, interleaved with what was done to it on
 *   its page (renaming, moving, restoring);
 * - `library`: what is done in the sidebar and on pages without a record (moving, renaming,
 *   archiving, restoring, folders, arranging).
 *
 * ⌘Z acts on what has focus: a text field undoes its own text, an editor without a place its
 * own typing, the sidebar (focused or last used) the library history; otherwise the place of the
 * page shown. App steps know how to undo and redo themselves and refuse if the file changed
 * since. Typing is a marker in a place's history; the editor holds the changes themselves.
 */
import { computed, signal } from "../ui/signal";
import { toast } from "../ui/toast";
import { errorText } from "../ui/dom";
import { router } from "./router";

export interface Undoable {
  label: string;
  undo(): Promise<void>;
  /** Does it again after an undo (without it, the step can't be redone). */
  redo?(): Promise<void>;
}

/** An editor's own history (CodeMirror's, or a board's drawing). */
export interface TextHistory {
  undo(): boolean;
  redo(): boolean;
  canUndo(): boolean;
  canRedo(): boolean;
  /** Typing after this starts a new step (so an app step isn't merged into typing). */
  isolate(): void;
}

export const LIBRARY = "library";
export const recordScope = (id: string) => `record:${id}`;

type AppEntry = { kind: "app"; step: Undoable; n: number };
type Entry = AppEntry | { kind: "text"; label?: string };
interface Stacks {
  past: readonly Entry[];
  future: readonly Entry[];
}

const DEPTH = 100;
const EMPTY: Stacks = { past: [], future: [] };

const stacks = signal<ReadonlyMap<string, Stacks>>(new Map());
/** Editors on screen: their element, their place (null: none) and their history. */
const editors = new Set<{ el: HTMLElement; scope: string | null; history: TextHistory }>();
const kept = new Map<string, { json: unknown; body: string }>();
let busy = false;
let counter = 0;
/** The place an action being run belongs to (`within`). */
let ambient: string | null = null;

const get = (scope: string): Stacks => stacks.peek().get(scope) ?? EMPTY;
function put(scope: string, s: Stacks): void {
  const m = new Map(stacks.peek());
  if (s.past.length || s.future.length) m.set(scope, { past: s.past.slice(-DEPTH), future: s.future });
  else m.delete(scope);
  stacks.set(m);
}
const historyOf = (scope: string) => [...editors].find((e) => e.scope === scope)?.history;
const labelOf = (e: Entry | undefined) => (!e ? null : e.kind === "text" ? (e.label ?? "Typing") : e.step.label);

// ---- What editors tell it ---------------------------------------------------------------------

/** An editor on screen, for a place (or none: its typing is its own). Returns how to let go. */
export function attachEditor(el: HTMLElement, scope: string | null, history: TextHistory): () => void {
  const mine = { el, scope, history };
  editors.add(mine);
  return () => editors.delete(mine);
}

/** The editor showing a place made a new history step (typing; "Drawing" on a board). */
export function typed(scope: string, label?: string): void {
  const s = get(scope);
  put(scope, { past: [...s.past, label ? { kind: "text", label } : { kind: "text" }], future: [] });
}

/** Keeps a place's typing history (as JSON) for when it is opened again. */
export function keepText(scope: string, json: unknown, body: string): void {
  kept.set(scope, { json, body });
}

/**
 * The kept typing history, if the text is still what it was; otherwise the place's typing steps
 * are forgotten (the file changed meanwhile), and its other steps stay.
 */
export function takeText(scope: string, body: string): unknown {
  const k = kept.get(scope);
  kept.delete(scope);
  if (k?.body === body) return k.json;
  const s = get(scope);
  const app = (es: readonly Entry[]) => es.filter((e) => e.kind === "app");
  if (app(s.past).length !== s.past.length || app(s.future).length !== s.future.length) put(scope, { past: app(s.past), future: app(s.future) });
  return null;
}

/** An editor's undo depth changed (so the Edit menu follows). */
export const editorChanged = signal(0);

// ---- App steps ----------------------------------------------------------------------------

/** Runs an action whose steps belong to `scope` (e.g. moving a note from its own page). */
export async function within<T>(scope: string, run: () => Promise<T>): Promise<T> {
  const before = ambient;
  ambient = scope;
  try {
    return await run();
  } finally {
    ambient = before;
  }
}

/** Records an action just done in its place's history, and offers to undo it. */
export function done(message: string, u: Undoable, scope = ambient ?? LIBRARY): void {
  const s = get(scope);
  put(scope, { past: [...s.past, { kind: "app", step: u, n: ++counter }], future: [] });
  historyOf(scope)?.isolate();
  toast(message, { action: { label: "Undo", run: () => void undoStep(u) } });
}

async function undoScope(scope: string): Promise<void> {
  const s = get(scope);
  const e = s.past.at(-1);
  if (busy || !e) return;
  put(scope, { past: s.past.slice(0, -1), future: s.future });
  if (e.kind === "app") return runUndo(scope, e);
  // The editor's history may hold fewer steps (merged typing): then the next step is tried.
  if (!historyOf(scope)?.undo()) return undoScope(scope);
  put(scope, { ...get(scope), future: [...get(scope).future, e] });
}

async function redoScope(scope: string): Promise<void> {
  const s = get(scope);
  const e = s.future.at(-1);
  if (busy || !e) return;
  put(scope, { past: s.past, future: s.future.slice(0, -1) });
  if (e.kind === "app") return runRedo(scope, e);
  if (!historyOf(scope)?.redo()) return redoScope(scope);
  put(scope, { ...get(scope), past: [...get(scope).past, e] });
}

/** The latest app step anywhere (or the latest undone one), for Edit ▸ Undo the last…. */
function latest(which: "past" | "future"): { scope: string; entry: AppEntry } | null {
  let best: { scope: string; entry: AppEntry } | null = null;
  for (const [scope, s] of stacks()) for (const e of s[which]) if (e.kind === "app" && (!best || e.n > best.entry.n)) best = { scope, entry: e };
  return best;
}
export const lastStep = computed(() => latest("past")?.entry.step ?? null);
export const nextStep = computed(() => latest("future")?.entry.step ?? null);

export async function undoLast(): Promise<void> {
  const l = latest("past");
  if (l) await undoEntry(l.scope, l.entry);
}

export async function redoLast(): Promise<void> {
  const l = latest("future");
  if (l) await redoEntry(l.scope, l.entry);
}

/** A toast's Undo: that step, wherever it sits. */
async function undoStep(u: Undoable): Promise<void> {
  for (const [scope, s] of stacks.peek()) {
    const e = s.past.find((x): x is AppEntry => x.kind === "app" && x.step === u);
    if (e) return undoEntry(scope, e);
  }
}

async function undoEntry(scope: string, e: AppEntry): Promise<void> {
  if (busy) return;
  const s = get(scope);
  put(scope, { past: s.past.filter((x) => x !== e), future: s.future });
  await runUndo(scope, e);
}

async function redoEntry(scope: string, e: AppEntry): Promise<void> {
  const s = get(scope);
  if (busy || !s.future.includes(e)) return;
  put(scope, { past: s.past, future: s.future.filter((x) => x !== e) });
  await runRedo(scope, e);
}

async function runUndo(scope: string, e: AppEntry): Promise<void> {
  const u = e.step;
  busy = true;
  try {
    await u.undo();
    // Stamped again: the latest undone is redone first.
    e.n = ++counter;
    if (u.redo) put(scope, { ...get(scope), future: [...get(scope).future, e] });
    toast(`Undone: ${u.label}`, u.redo ? { action: { label: "Redo", run: () => void redoEntry(scope, e) } } : {});
  } catch (err) {
    toast(errorText(err) || "That can’t be undone any more.");
  } finally {
    busy = false;
  }
}

async function runRedo(scope: string, e: AppEntry): Promise<void> {
  const u = e.step;
  if (!u.redo) return;
  busy = true;
  try {
    await u.redo();
    e.n = ++counter;
    put(scope, { ...get(scope), past: [...get(scope).past, e] });
    historyOf(scope)?.isolate();
    toast(`Redone: ${u.label}`, { action: { label: "Undo", run: () => void undoStep(u) } });
  } catch (err) {
    toast(errorText(err) || "That can’t be done again any more.");
  } finally {
    busy = false;
  }
}

// ---- What ⌘Z acts on ----------------------------------------------------------------------

type Target = { scope: string } | { history: TextHistory } | { field: HTMLInputElement | HTMLTextAreaElement };
const TEXT_INPUTS = new Set(["text", "search", "url", "email", "tel", "number", ""]);

/** The part of the window last worked in: menus and dialogs, outside both, don't change it. */
let region: "sidebar" | "page" | null = null;
const focusMoved = signal(0);
const bump = () => focusMoved.set(focusMoved.peek() + 1);
document.addEventListener("pointerdown", (e) => {
  const el = e.target as Element | null;
  if (el?.closest?.(".app-sidebar")) region = "sidebar";
  else if (el?.closest?.(".workspace")) region = "page";
  bump();
}, true);
document.addEventListener("focusin", bump);
document.addEventListener("focusout", () => setTimeout(bump, 0));
// A field's typing makes its undo possible.
document.addEventListener("input", (e) => !(e.target as Element | null)?.closest?.(".cm-editor") && bump());

function target(): Target {
  const a = document.activeElement;
  const ed = a && [...editors].find((x) => x.el.contains(a));
  if (ed) return ed.scope ? { scope: ed.scope } : { history: ed.history };
  if ((a instanceof HTMLTextAreaElement || (a instanceof HTMLInputElement && TEXT_INPUTS.has(a.type))) && !a.readOnly && !a.disabled) return { field: a };
  if (a?.closest(".app-sidebar") || ((!a || a === document.body) && region === "sidebar")) return { scope: LIBRARY };
  const id = router.current().params.id;
  return { scope: id ? recordScope(id) : LIBRARY };
}

/** What Undo and Redo would act on now, and whether they can (reactive, for the Edit menu). */
function here(which: "past" | "future") {
  return computed(() => {
    editorChanged();
    focusMoved();
    const t = target();
    // A field doesn't say how much it can undo.
    if ("field" in t) return { can: true, label: null };
    if ("history" in t) return { can: which === "past" ? t.history.canUndo() : t.history.canRedo(), label: null };
    const e = stacks().get(t.scope)?.[which].at(-1);
    return { can: !!e, label: labelOf(e) };
  });
}
export const undoHere = here("past");
export const redoHere = here("future");

function act(which: "undo" | "redo"): void {
  const t = target();
  if ("field" in t) document.execCommand(which);
  else if ("history" in t) void (which === "undo" ? t.history.undo() : t.history.redo());
  else void (which === "undo" ? undoScope(t.scope) : redoScope(t.scope));
}
export const undo = () => act("undo");
export const redo = () => act("redo");
