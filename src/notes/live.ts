/**
 * A shared note, live: what is typed here goes to the shared document a moment later, what
 * colleagues type comes in (not as steps to undo), and their cursors show with their names. The
 * backend keeps the document (src-tauri/src/sharing/notes.rs).
 *
 * As on a shared board (src/boards/live.ts), each push is based on the document's state this
 * page last had ("heads"), so the document merges it with what colleagues typed meanwhile: both
 * keep their words. While something typed here isn't pushed yet, or a push is on its way, what
 * arrives waits, and the latest state is fetched once the push is in.
 */
import { Annotation, StateEffect, StateField, Transaction } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, type DecorationSet } from "@codemirror/view";
import { call, on } from "../backend";
import { signal, type Signal } from "../ui/signal";
import { COLORS } from "../boards/live";
import type { SharedNote } from "../types";

const PUSH_MS = 150;
/** The cursor is sent at most this often, and again now and then while it rests. */
const CURSOR_MS = 80;
const BEAT_MS = 15_000;
/** A colleague not heard from for this long is taken off the note. */
const GONE_MS = 45_000;

interface Cursor {
  name: string;
  color: string;
  anchor: number;
  head: number;
  at: number;
}

/** A change that came from colleagues: it isn't pushed back, nor kept as a step to undo. */
const remote = Annotation.define<boolean>();
const setCursors = StateEffect.define<Cursor[]>();

/** A colleague's caret, with their name above it. */
class Caret extends WidgetType {
  constructor(readonly name: string, readonly color: string) {
    super();
  }
  eq(o: Caret) {
    return o.name === this.name && o.color === this.color;
  }
  toDOM() {
    const caret = document.createElement("span");
    caret.className = "cm-peer-caret";
    caret.style.borderColor = this.color;
    const name = caret.appendChild(document.createElement("span"));
    name.className = "cm-peer-name";
    name.style.background = this.color;
    name.textContent = this.name;
    return caret;
  }
  ignoreEvent() {
    return true;
  }
}

const decorate = (list: Cursor[], length: number): DecorationSet =>
  Decoration.set(list.flatMap((c) => {
    const anchor = Math.min(c.anchor, length);
    const head = Math.min(c.head, length);
    const [from, to] = anchor < head ? [anchor, head] : [head, anchor];
    const caret = Decoration.widget({ widget: new Caret(c.name, c.color), side: 1 }).range(head);
    return from < to ? [Decoration.mark({ attributes: { style: `background: ${c.color}33` } }).range(from, to), caret] : [caret];
  }), true);

/** Colleagues' cursors, moved along with the text as it changes here. */
const cursors = StateField.define<{ list: Cursor[]; deco: DecorationSet }>({
  create: () => ({ list: [], deco: Decoration.none }),
  update(v, tr) {
    let list = v.list;
    // A colleague's position is in the shared text as they have it, their own typing included:
    // it moves with what is typed here, not with what arrives. It can be ahead of the text here
    // for a moment, so it is kept within it.
    const within = (n: number, length: number) => Math.min(Math.max(0, n), length);
    const before = tr.startState.doc.length;
    if (tr.docChanged && !tr.annotation(remote)) list = list.map((c) => ({ ...c, anchor: tr.changes.mapPos(within(c.anchor, before)), head: tr.changes.mapPos(within(c.head, before)) }));
    for (const e of tr.effects) if (e.is(setCursors)) list = e.value;
    return list === v.list && !tr.docChanged ? v : { list, deco: decorate(list, tr.state.doc.length) };
  },
  provide: (f) => EditorView.decorations.from(f, (v) => v.deco),
});

/** Makes the editor's text `text` by the least edit (the cursor and selection stay put). */
function become(view: EditorView, text: string): boolean {
  const cur = view.state.doc.toString();
  if (cur === text) return false;
  const half = (s: string, i: number) => i > 0 && i < s.length && /[\uDC00-\uDFFF]/.test(s[i]!);
  let a = 0;
  while (a < cur.length && a < text.length && cur[a] === text[a]) a++;
  while (half(cur, a) || half(text, a)) a--;
  let b = 0;
  while (b < cur.length - a && b < text.length - a && cur[cur.length - 1 - b] === text[text.length - 1 - b]) b++;
  while (half(cur, cur.length - b) || half(text, text.length - b)) b--;
  view.dispatch({ changes: { from: a, to: cur.length - b, insert: text.slice(a, text.length - b) }, annotations: [remote.of(true), Transaction.addToHistory.of(false)] });
  return true;
}

export interface LiveNote {
  /** The link colleagues are sent, while the note is shared. */
  readonly link: Signal<string | null>;
  /** How many colleagues are in the note now. */
  readonly here: Signal<number>;
  /** The note was shared (or stopped being) from this page. */
  refresh(): Promise<void>;
  stop(): void;
}

/** Follows the note `id` in `view` if it is shared. */
export function liveNote(id: string, view: EditorView): LiveNote {
  const link = signal<string | null>(null);
  const here = signal(0);
  /** This page, told apart from the same note open elsewhere (another window or tab). */
  const page = Math.random().toString(36).slice(2);
  let heads: string[] = [];
  let unpushed = false;
  let pushing = 0;
  let behind = false;
  let pushTimer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  // The shared document always wins over the page: text the file has and it doesn't (edited
  // outside Librarium, say) is replaced, never pushed over colleagues' words. The note's
  // history keeps it.
  const apply = (s: { text: string; heads: string[] }) => {
    heads = s.heads;
    become(view, s.text);
  };
  const refresh = async () => {
    const s = await call<SharedNote | null>("sharing.watchNote", { id, open: true, page }).catch(() => null);
    if (stopped) return;
    link.set(s?.link ?? null);
    if (s?.text != null) apply({ text: s.text, heads: s.heads });
  };
  const push = async () => {
    clearTimeout(pushTimer);
    if (!link.peek() || stopped) return;
    unpushed = false;
    pushing++;
    try {
      heads = await call<string[]>("sharing.pushNote", { id, text: view.state.doc.toString(), heads });
    } catch {
      unpushed = true;
    } finally {
      pushing--;
    }
    if (unpushed) return void (pushTimer = setTimeout(() => void push(), PUSH_MS));
    if (!pushing && behind) ((behind = false), void refresh());
  };
  const changed = () => {
    if (!link.peek()) return;
    unpushed = true;
    clearTimeout(pushTimer);
    pushTimer = setTimeout(() => void push(), PUSH_MS);
  };
  const offArrived = on<{ id: string; text: string; heads: string[] }>("sharing.note", (s) => {
    if (s.id !== id || stopped) return;
    if (unpushed || pushing) {
      behind = true;
      if (unpushed && !pushing) void push();
      return;
    }
    apply(s);
  });

  // ---- Cursors ----
  /** Each colleague's cursor, by their device and page (one person can have a note open twice). */
  const peers = new Map<string, Cursor & { peer: string }>();
  const colorOf = (peer: string) => COLORS[[...peer].reduce((n, c) => n + c.charCodeAt(0), 0) % COLORS.length]!;
  const showPeers = () => {
    const now = Date.now();
    for (const [k, c] of peers) if (now - c.at > GONE_MS) peers.delete(k);
    here.set(new Set([...peers.values()].map((c) => c.peer)).size);
    view.dispatch({ effects: setCursors.of([...peers.values()]) });
  };
  const offCursor = on<{ note: string; peer: string; page?: string; name: string | null; anchor?: number; head?: number; gone?: boolean }>("sharing.cursor", (c) => {
    if (c.note !== id || stopped) return;
    const key = `${c.peer} ${c.page ?? ""}`;
    if (c.gone) peers.delete(key);
    else peers.set(key, { peer: c.peer, name: c.name || "Colleague", color: colorOf(c.peer), anchor: c.anchor ?? 0, head: c.head ?? 0, at: Date.now() });
    showPeers();
  });
  let lastCursor = 0;
  let cursorTimer: ReturnType<typeof setTimeout> | undefined;
  const sendCursor = () => {
    if (!link.peek() || stopped) return;
    clearTimeout(cursorTimer);
    const wait = CURSOR_MS - (Date.now() - lastCursor);
    if (wait > 0) return void (cursorTimer = setTimeout(sendCursor, wait));
    lastCursor = Date.now();
    const { anchor, head } = view.state.selection.main;
    void call("sharing.cursor", { id, data: { page, anchor, head } }).catch(() => {});
    cursorTimer = setTimeout(sendCursor, BEAT_MS);
  };
  const sweep = setInterval(showPeers, 10_000);

  view.dispatch({
    effects: StateEffect.appendConfig.of([cursors, EditorView.updateListener.of((u) => {
      if (stopped) return;
      if (u.docChanged && !u.transactions.some((t) => t.annotation(remote))) changed();
      if (u.docChanged || u.selectionSet) sendCursor();
    })]),
  });

  void refresh().then(sendCursor);
  return {
    link,
    here,
    async refresh() {
      await refresh();
      sendCursor();
    },
    stop() {
      if (unpushed) void push();
      if (link.peek()) void call("sharing.cursor", { id, data: { page, gone: true } }).catch(() => {});
      stopped = true;
      clearTimeout(pushTimer);
      clearTimeout(cursorTimer);
      clearInterval(sweep);
      offArrived();
      offCursor();
      void call("sharing.watchNote", { id, open: false, page }).catch(() => {});
    },
  };
}
