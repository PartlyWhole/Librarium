/**
 * The editor: CodeMirror 6 with Markdown live preview, links, embeds, formatting, lists, folding
 * and the clipboard. Its typing history is CodeMirror's; the app's Undo (app/undo.ts) decides
 * when to use it, so typing and a note's other steps undo in the order they were done.
 */
import { closeBrackets, closeBracketsKeymap, completionKeymap } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyField, indentWithTab, isolateHistory, redo, redoDepth, undo, undoDepth } from "@codemirror/commands";
import { bracketMatching, indentOnInput, indentUnit } from "@codemirror/language";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import { EditorState, StateEffect, StateField, Transaction, type Extension } from "@codemirror/state";
import { crosshairCursor, drawSelection, EditorView, keymap, placeholder, rectangularSelection } from "@codemirror/view";
import { editorChanged, type TextHistory } from "../../app/undo";
import { embedExtension, embedShown } from "../embeds";
import { clipboard, clipboardKeymap } from "./clipboard";
import { linkCompletion, type LinkTarget } from "./complete";
import { folding } from "./folding";
import { formatKeymap, wrapOnType } from "./format";
import { indentation } from "./indent";
import { formatLink, parseLinks } from "./links";
import { hangingIndent, listKeymap, markupKeymap } from "./lists";
import { livePreview } from "./livepreview";
import { markdownSupport } from "./markdown";

interface EditorOptions {
  parent: HTMLElement;
  doc: string;
  readOnly?: boolean;
  label: string;
  targets: () => LinkTarget[];
  open: (id: string, opts?: { newTab?: boolean }) => void;
  titleOf: (id: string) => string | null;
  onChange?: () => void;
  onBlur?: () => void;
  /** After any change of text or selection (debounce heavy work). */
  onUpdate?: (view: EditorView) => void;
  /** Makes a note for an unresolved link's words; resolves with its ID (the link is completed). */
  create?: (label: string) => Promise<string | null>;
  /** Files pasted into the text (a copied picture). */
  onFiles?: (view: EditorView, files: File[]) => void;
  /** A typing history kept from before (`historyJSON`), for this same text. */
  history?: unknown;
  /** Typing made a new undo step (not undoing or redoing). */
  onHistoryStep?: () => void;
  placeholder?: string;
}

let active: EditorView | null = null;

/** The editor last focused, if it is still shown (the Format menu acts on it). */
export function activeEditor(): EditorView | null {
  return active && active.dom.isConnected && !active.dom.closest("[hidden]") ? active : null;
}

// While ⌘ is held, a link being edited reacts to the pointer as a link (⌘-click opens it).
const modHeld = (on: boolean) => document.documentElement.classList.toggle("mod-held", on);
window.addEventListener("keydown", (e) => modHeld(e.metaKey), true);
window.addEventListener("keyup", (e) => modHeld(e.metaKey), true);
window.addEventListener("mousemove", (e) => modHeld(e.metaKey), { capture: true, passive: true });
window.addEventListener("blur", () => modHeld(false));

// After an app step (a rename), the next typing starts a new undo step.
const isolateNext = StateEffect.define<null>();
const isolating = StateField.define<boolean>({
  create: () => false,
  update: (v, tr) => (tr.effects.some((e) => e.is(isolateNext)) ? true : tr.docChanged ? false : v),
});
const isolate = EditorState.transactionExtender.of((tr) => (tr.docChanged && tr.startState.field(isolating, false) ? { annotations: isolateHistory.of("before") } : null));

/** An editor's typing history, for the app's Undo. */
export function textHistory(view: EditorView): TextHistory {
  return {
    undo: () => undo(view),
    redo: () => redo(view),
    canUndo: () => undoDepth(view.state) > 0,
    canRedo: () => redoDepth(view.state) > 0,
    isolate: () => view.dispatch({ effects: isolateNext.of(null) }),
  };
}

/** The editor's state with its typing history, to give back to `createEditor` later. */
export function historyJSON(view: EditorView): unknown {
  return view.state.toJSON({ history: historyField });
}

export function createEditor(o: EditorOptions): EditorView {
  /** Opens a link's record; an unresolved one makes its note, completes the link, then opens it. */
  const follow = (view: EditorView, id: string | null, label: string, pos: number, newTab: boolean) => {
    if (id) return o.open(id, { newTab });
    void o.create?.(label).then((made) => {
      if (!made) return;
      const l = parseLinks(view.state.doc.toString()).find((x) => !x.id && x.label === label && x.from <= pos && x.to >= pos);
      if (l) view.dispatch({ changes: { from: l.from, to: l.to, insert: formatLink(label, made, l.embed) }, userEvent: "input.link" });
      o.open(made, { newTab });
    });
  };
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
    markupKeymap,
    ...folding,
    livePreview({ titleOf: o.titleOf, embedShown }),
    embedExtension(),
    linkCompletion(o.targets),
    clipboard,
    keymap.of([...formatKeymap, ...clipboardKeymap, ...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...completionKeymap, ...listKeymap, indentWithTab]),
    hangingIndent,
    // Outside lists, Tab inserts a tab.
    indentUnit.of("\t"),
    indentation,
    EditorView.contentAttributes.of({ "aria-label": o.label, "aria-multiline": "true", spellcheck: "true", autocorrect: "on" }),
    EditorState.readOnly.of(!!o.readOnly),
    EditorView.editable.of(!o.readOnly),
    isolating,
    isolate,
    EditorView.updateListener.of((u) => {
      if (u.docChanged) o.onChange?.();
      if (o.onHistoryStep) {
        for (const tr of u.transactions) {
          if (tr.docChanged && !tr.isUserEvent("undo") && !tr.isUserEvent("redo") && undoDepth(tr.state) > undoDepth(tr.startState)) o.onHistoryStep();
        }
      }
      if (u.focusChanged && u.view.hasFocus) active = u.view;
      if (u.docChanged || u.focusChanged) editorChanged.set(editorChanged.peek() + 1);
      if (u.docChanged || u.selectionSet || u.focusChanged) o.onUpdate?.(u.view);
      if (u.focusChanged && !u.view.hasFocus) o.onBlur?.();
    }),
    EditorView.domEventHandlers({
      // A shown link keeps the cursor where it is, so the click that follows opens it. A link
      // being edited (its `[[…]]` showing) opens with ⌘-click; a plain click places the cursor.
      mousedown(e, view) {
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
      // Click opens; ⌘-click opens in a new tab.
      click(e, view) {
        const t = (e.target as HTMLElement).closest<HTMLElement>(".cm-wikilink");
        if (t?.dataset.id) {
          e.preventDefault();
          follow(view, t.dataset.id, "", 0, e.metaKey);
          return true;
        }
        if (t?.dataset.label !== undefined && o.create && !view.state.readOnly) {
          e.preventDefault();
          follow(view, null, t.dataset.label, view.posAtDOM(t), e.metaKey);
          return true;
        }
        return false;
      },
      auxclick(e) {
        const t = (e.target as HTMLElement).closest<HTMLElement>(".cm-wikilink");
        if (e.button !== 1 || !t?.dataset.id) return false;
        e.preventDefault();
        o.open(t.dataset.id, { newTab: true });
        return true;
      },
      paste(e, view) {
        const files = [...(e.clipboardData?.files ?? [])];
        if (!files.length || view.state.readOnly || !o.onFiles) return false;
        e.preventDefault();
        o.onFiles(view, files);
        return true;
      },
    }),
  ];
  if (o.placeholder) extensions.push(placeholder(o.placeholder));
  let state: EditorState | null = null;
  if (o.history) {
    try {
      state = EditorState.fromJSON(o.history, { extensions }, { history: historyField });
      if (state.doc.toString() !== o.doc) state = null;
    } catch {
      state = null;
    }
  }
  return new EditorView({ parent: o.parent, state: state ?? EditorState.create({ doc: o.doc, extensions }) });
}

/**
 * Embeds `![[label|id]]` on their own lines, where a point is (a drop) or at the cursor, then
 * puts the cursor after them.
 */
export function insertEmbeds(view: EditorView, links: { label: string; id: string }[], at?: { x: number; y: number }): void {
  if (!links.length || view.state.readOnly) return;
  const pos = (at && view.posAtCoords(at)) ?? view.state.selection.main.head;
  const line = view.state.doc.lineAt(pos);
  const filled = !!line.text.trim();
  const text = (filled ? "\n" : "") + links.map((l) => formatLink(l.label, l.id, true)).join("\n") + "\n";
  const from = filled ? line.to : line.from;
  view.dispatch({ changes: { from, insert: text }, selection: { anchor: from + text.length }, userEvent: "input.paste", scrollIntoView: true });
  view.focus();
}

/**
 * Replaces the whole text as one change that isn't a typing step (an outside edit, a merge, a
 * restored version): the undo belongs to whatever changed the file. Only the differing middle
 * changes, so the cursor stays sensible.
 */
export function replaceDoc(view: EditorView, text: string): void {
  const cur = view.state.doc.toString();
  if (cur === text) return;
  let a = 0;
  while (a < cur.length && a < text.length && cur[a] === text[a]) a++;
  let b = 0;
  while (b < cur.length - a && b < text.length - a && cur[cur.length - 1 - b] === text[text.length - 1 - b]) b++;
  view.dispatch({ changes: { from: a, to: cur.length - b, insert: text.slice(a, text.length - b) }, annotations: Transaction.addToHistory.of(false) });
}

/** A code-point offset (from search or the index) as the editor's UTF-16 position. */
export function positionOf(view: EditorView, codePoints: number): number {
  let pos = 0;
  let n = 0;
  for (const ch of view.state.doc.toString()) {
    if (n++ >= codePoints) break;
    pos += ch.length;
  }
  return pos;
}
