/**
 * The editor: CodeMirror 6 with Markdown live preview, links, history and the editor's
 * extension slot. Text undo is CodeMirror's history; when the editor has focus its keymap wins,
 * except for the app's reserved shortcuts (handled by the shell before CodeMirror sees them).
 */
import { EditorState, StateEffect, StateField, Transaction, type Extension } from "@codemirror/state";
import { signal } from "../kit/signal";
import { EditorView, keymap, drawSelection, placeholder as placeholderExt, rectangularSelection, crosshairCursor } from "@codemirror/view";
import { defaultKeymap, history, historyField, indentWithTab, isolateHistory, redo, undo, undoDepth } from "@codemirror/commands";
import { searchKeymap, highlightSelectionMatches } from "@codemirror/search";
import { indentOnInput, indentUnit, bracketMatching } from "@codemirror/language";
import { closeBrackets, closeBracketsKeymap, completionKeymap } from "@codemirror/autocomplete";
import { markdownSupport } from "./markdown";
import { livePreview } from "./livepreview";
import { linkCompletion, type LinkTarget } from "./complete";
import { formatLink, parseLinks } from "./links";
import { formatKeymap, wrapOnType } from "./format";
import { hangingIndent, listKeymap } from "./lists";
import { indentation } from "./indent";
import { clipboard, clipboardKeymap } from "./clipboard";
import { codeHighlighting } from "./code";
import { folding } from "./folding";

let active: EditorView | null = null;

/** While ⌘ is held, `[[…]]` being edited reacts to the pointer as a link (⌘-click opens it). */
if (typeof window !== "undefined") {
  const mod = (on: boolean) => document.documentElement.classList.toggle("mod-held", on);
  window.addEventListener("keydown", (e) => mod(e.metaKey), true);
  window.addEventListener("keyup", (e) => mod(e.metaKey), true);
  window.addEventListener("mousemove", (e) => mod(e.metaKey), { capture: true, passive: true });
  window.addEventListener("blur", () => mod(false));
}
/** Bumped when any editor's text or focus changes (Edit ▸ Undo follows it). */
export const editorChanged = signal(0);

/** The editor last focused, if it is still on the page (the Format menu acts on it). */
export function activeEditor(): EditorView | null {
  return active && active.dom.isConnected && !active.dom.closest("[hidden]") ? active : null;
}

/** shell.editor-extensions: a module adds behaviour to every editor. */
export interface EditorContribution {
  id: string;
  /** Embeds drawn by this extension (the editor then leaves them alone). */
  handlesEmbeds?: boolean;
  /** Whether it can draw this embed now; if not, the embed shows as its source. */
  embedShown?: (id: string) => boolean;
  extension(ctx: EditorContext): Extension;
}

export interface EditorContext {
  /** Opens a link's target (in a new tab when asked: ⌘-click or a middle-click). */
  open(id: string, opts?: { newTab?: boolean }): void;
  titleOf(id: string): string | null;
}

export interface EditorOptions {
  parent: HTMLElement;
  doc: string;
  readOnly?: boolean;
  label: string;
  targets: () => LinkTarget[];
  open: (id: string, opts?: { newTab?: boolean }) => void;
  titleOf: (id: string) => string | null;
  onChange?: (doc: string) => void;
  onBlur?: () => void;
  /** Called after any change of text or selection (debounce it for heavy work). */
  onUpdate?: (view: EditorView) => void;
  /** Makes a note for an unresolved link's words; returns its ID (the link is then completed). */
  create?: (label: string, opts: { newTab: boolean }) => Promise<string | null>;
  contributions?: EditorContribution[];
  placeholder?: string;
  /** A typing history kept from before (`historyJSON`), for this same text. */
  history?: unknown;
  /** Called when typing makes a new undo step (not when undoing or redoing). */
  onHistoryStep?: () => void;
}

// ⌘Z / ⇧⌘Z are the app's (text-undo.ts): it undoes typing through `textHistory` when the page's
// history says so, so typing and the page's other steps undo in the order they were done.
const isolateNext = StateEffect.define<null>();
const isolating = StateField.define<boolean>({
  create: () => false,
  update: (v, tr) => (tr.effects.some((e) => e.is(isolateNext)) ? true : tr.docChanged ? false : v),
});
const isolate = EditorState.transactionExtender.of((tr) => (tr.docChanged && tr.startState.field(isolating, false) ? { annotations: isolateHistory.of("before") } : null));

/** An editor's typing history, for the app's Undo. */
export function textHistory(view: EditorView) {
  return {
    undo: () => undo(view),
    redo: () => redo(view),
    isolate: () => view.dispatch({ effects: isolateNext.of(null) }),
  };
}

/** The editor's state with its typing history, to give back to `createEditor` later. */
export function historyJSON(view: EditorView): unknown {
  return view.state.toJSON({ history: historyField });
}

export function createEditor(o: EditorOptions): EditorView {
  const ctx: EditorContext = { open: o.open, titleOf: o.titleOf };
  /** Opens a link's record; an unresolved one (no ID) makes its note (as in Obsidian),
   * completes the link at `pos`, then opens it. */
  const follow = (view: EditorView, id: string | null, label: string, pos: number, newTab: boolean) => {
    if (id) return o.open(id, { newTab });
    void o.create?.(label, { newTab }).then((made) => {
      if (!made) return;
      const l = parseLinks(view.state.doc.toString()).find((x) => !x.id && x.label === label && x.from <= pos && x.to >= pos);
      if (l) view.dispatch({ changes: { from: l.from, to: l.to, insert: formatLink(label, made, l.embed) }, userEvent: "input.link" });
      o.open(made, { newTab });
    });
  };
  const contributions = o.contributions ?? [];
  const extensions: Extension[] = [
    history(),
    drawSelection(),
    // Several cursors: ⌘D adds the next match, ⌥-click adds a cursor, ⌥-drag selects a block.
    EditorState.allowMultipleSelections.of(true),
    EditorView.clickAddsSelectionRange.of((e) => e.altKey),
    rectangularSelection(),
    crosshairCursor(),
    wrapOnType,
    indentOnInput(),
    bracketMatching(),
    closeBrackets(),
    highlightSelectionMatches(),
    EditorView.lineWrapping,
    markdownSupport(),
    codeHighlighting,
    ...folding,
    livePreview({ titleOf: o.titleOf, embedsHandled: contributions.some((c) => c.handlesEmbeds), embedShown: contributions.find((c) => c.handlesEmbeds)?.embedShown }),
    linkCompletion(o.targets),
    clipboard,
    keymap.of([...formatKeymap, ...clipboardKeymap, ...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...completionKeymap, ...listKeymap, indentWithTab]),
    hangingIndent,
    // Tab on a line that isn't a list item indents it with a tab (decision 0058).
    indentUnit.of("\t"),
    indentation,
    EditorView.contentAttributes.of({ "aria-label": o.label, "aria-multiline": "true", spellcheck: "true", autocorrect: "on" }),
    EditorState.readOnly.of(!!o.readOnly),
    EditorView.editable.of(!o.readOnly),
    isolating,
    isolate,
    EditorView.updateListener.of((u) => {
      if (u.docChanged) o.onChange?.(u.state.doc.toString());
      if (o.onHistoryStep) for (const tr of u.transactions) {
        if (tr.docChanged && !tr.isUserEvent("undo") && !tr.isUserEvent("redo") && undoDepth(tr.state) > undoDepth(tr.startState)) o.onHistoryStep();
      }
      if (u.focusChanged && u.view.hasFocus) active = u.view;
      if (u.docChanged || u.focusChanged) editorChanged.set(editorChanged.peek() + 1);
      if (u.docChanged || u.selectionSet || u.focusChanged) o.onUpdate?.(u.view);
      if (u.focusChanged && !u.view.hasFocus) o.onBlur?.();
    }),
    EditorView.domEventHandlers({
      // A link being edited (its `[[…]]` showing) opens with ⌘-click, as in Obsidian; a plain
      // click places the cursor in it. Handled on mousedown so the cursor doesn't move first.
      mousedown(e, view) {
        // A shown link: keep the cursor where it is, so the link stays shown and the click
        // that follows (below) lands on it and opens it.
        const shown = (e.target as HTMLElement).closest<HTMLElement>(".cm-wikilink");
        if (e.button === 0 && shown && (shown.dataset.id || shown.dataset.label !== undefined)) {
          e.preventDefault();
          return true;
        }
        if (e.button !== 0 || !e.metaKey || e.shiftKey || e.altKey || e.ctrlKey) return false;
        const src = (e.target as HTMLElement).closest<HTMLElement>(".cm-wikilink-source");
        if (!src) return false;
        const pos = view.posAtDOM(src);
        const l = parseLinks(view.state.doc.toString()).find((x) => pos >= x.from && pos <= x.to);
        if (!l || (!l.id && (!o.create || view.state.readOnly))) return false;
        e.preventDefault();
        follow(view, l.id, l.label, l.from, false);
        return true;
      },
      click(e, view) {
        // A link opens here; with ⌘, in a new tab (as in Obsidian).
        const newTab = e.metaKey;
        const t = (e.target as HTMLElement).closest<HTMLElement>(".cm-wikilink");
        if (t?.dataset.id) {
          e.preventDefault();
          follow(view, t.dataset.id, "", 0, newTab);
          return true;
        }
        if (t?.dataset.label !== undefined && o.create && !view.state.readOnly) {
          e.preventDefault();
          follow(view, null, t.dataset.label, view.posAtDOM(t), newTab);
          return true;
        }
        return false;
      },
      // Files pasted (an image copied elsewhere): whoever stores them (Library) is asked, and
      // answers with `librarium:insert-embeds` (below).
      paste(e, view) {
        const files = [...(e.clipboardData?.files ?? [])];
        if (!files.length || view.state.readOnly) return false;
        e.preventDefault();
        view.dom.dispatchEvent(new CustomEvent("librarium:files", { bubbles: true, detail: { files } }));
        return true;
      },
      // A middle-click on a link opens it in a new tab.
      auxclick(e) {
        const t = (e.target as HTMLElement).closest<HTMLElement>(".cm-wikilink");
        if (e.button !== 1 || !t?.dataset.id) return false;
        e.preventDefault();
        o.open(t.dataset.id, { newTab: true });
        return true;
      },
    }),
    ...contributions.map((c) => c.extension(ctx)),
    paintProbe(),
  ];
  if (o.placeholder) extensions.push(placeholderExt(o.placeholder));
  let state: EditorState | null = null;
  if (o.history) {
    try {
      state = EditorState.fromJSON(o.history, { extensions }, { history: historyField });
      if (state.doc.toString() !== o.doc) state = null;
    } catch {
      state = null;
    }
  }
  const view = new EditorView({ parent: o.parent, state: state ?? EditorState.create({ doc: o.doc, extensions }) });
  // Records to embed (images pasted or dropped, once stored): `![[title|id]]`, each on its own
  // line, where they were dropped (x, y) or at the cursor.
  view.dom.addEventListener("librarium:insert-embeds", (ev) => {
    const d = (ev as CustomEvent<{ links: { label: string; id: string }[]; x?: number; y?: number }>).detail;
    if (!d?.links?.length || view.state.readOnly) return;
    const at = d.x !== undefined && d.y !== undefined ? view.posAtCoords({ x: d.x, y: d.y }) ?? view.state.selection.main.head : view.state.selection.main.head;
    const line = view.state.doc.lineAt(at);
    const before = line.text.trim() ? "\n" : "";
    const text = before + d.links.map((l) => formatLink(l.label, l.id, true)).join("\n") + "\n";
    const pos = line.text.trim() ? line.to : line.from;
    view.dispatch({ changes: { from: pos, insert: text }, selection: { anchor: pos + text.length }, userEvent: "input.paste", scrollIntoView: true });
    view.focus();
  });
  return view;
}

/** Keystroke-to-paint times (ms), for the 16 ms budget: keydown to the next frame. */
export const keystrokes: number[] = [];

function paintProbe(): Extension {
  // beforeinput fires for every typed character (and for synthetic typing in tests).
  return EditorView.domEventHandlers({
    beforeinput() {
      const t = performance.now();
      requestAnimationFrame(() => {
        keystrokes.push(performance.now() - t);
        if (keystrokes.length > 1000) keystrokes.shift();
      });
      return false;
    },
  });
}

/** Replaces the whole document as one change, keeping history. */
export function replaceDoc(view: EditorView, text: string): void {
  const cur = view.state.doc.toString();
  if (cur === text) return;
  // Change only the differing middle, so the cursor and undo stay sensible.
  let a = 0;
  while (a < cur.length && a < text.length && cur[a] === text[a]) a++;
  let b = 0;
  while (b < cur.length - a && b < text.length - a && cur[cur.length - 1 - b] === text[text.length - 1 - b]) b++;
  // Not a typing step: undo belongs to whatever changed the file (an outside edit, a restored
  // version, a capture's places rewritten), and typing before it still undoes (0060).
  view.dispatch({ changes: { from: a, to: cur.length - b, insert: text.slice(a, text.length - b) }, annotations: Transaction.addToHistory.of(false) });
}
