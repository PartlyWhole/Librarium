/**
 * The editor: CodeMirror 6 with Markdown live preview, links, history and the editor's
 * extension slot. Text undo is CodeMirror's history; when the editor has focus its keymap wins,
 * except for the app's reserved shortcuts (handled by the shell before CodeMirror sees them).
 */
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView, keymap, drawSelection, placeholder as placeholderExt, rectangularSelection, crosshairCursor } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { searchKeymap, highlightSelectionMatches } from "@codemirror/search";
import { indentOnInput, bracketMatching } from "@codemirror/language";
import { closeBrackets, closeBracketsKeymap, completionKeymap } from "@codemirror/autocomplete";
import { markdownSupport } from "./markdown";
import { livePreview } from "./livepreview";
import { linkCompletion, type LinkTarget } from "./complete";
import { parseLinks } from "./links";
import { formatKeymap, wrapOnType } from "./format";
import { hangingIndent, listKeymap } from "./lists";
import { clipboard, clipboardKeymap } from "./clipboard";

let active: EditorView | null = null;

/** The editor last focused, if it is still on the page (the Format menu acts on it). */
export function activeEditor(): EditorView | null {
  return active && active.dom.isConnected && !active.dom.closest("[hidden]") ? active : null;
}

/** shell.editor-extensions: a module adds behaviour to every editor. */
export interface EditorContribution {
  id: string;
  /** Embeds drawn by this extension (the editor then leaves them alone). */
  handlesEmbeds?: boolean;
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
  contributions?: EditorContribution[];
  placeholder?: string;
}

export function createEditor(o: EditorOptions): EditorView {
  const ctx: EditorContext = { open: o.open, titleOf: o.titleOf };
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
    livePreview({ titleOf: o.titleOf, embedsHandled: contributions.some((c) => c.handlesEmbeds) }),
    linkCompletion(o.targets),
    clipboard,
    keymap.of([...formatKeymap, ...clipboardKeymap, ...closeBracketsKeymap, ...defaultKeymap, ...historyKeymap, ...searchKeymap, ...completionKeymap, ...listKeymap, indentWithTab]),
    hangingIndent,
    EditorView.contentAttributes.of({ "aria-label": o.label, "aria-multiline": "true", spellcheck: "true", autocorrect: "on" }),
    EditorState.readOnly.of(!!o.readOnly),
    EditorView.editable.of(!o.readOnly),
    EditorView.updateListener.of((u) => {
      if (u.docChanged) o.onChange?.(u.state.doc.toString());
      if (u.focusChanged && u.view.hasFocus) active = u.view;
      if (u.focusChanged && !u.view.hasFocus) o.onBlur?.();
    }),
    EditorView.domEventHandlers({
      click(e, view) {
        // A link opens here; with ⌘, in a new tab (as in Obsidian).
        const newTab = e.metaKey;
        const t = (e.target as HTMLElement).closest<HTMLElement>(".cm-wikilink");
        if (t?.dataset.id) {
          e.preventDefault();
          o.open(t.dataset.id, { newTab });
          return true;
        }
        // ⌘-click on a link's source opens it too.
        if (e.metaKey) {
          const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
          if (pos !== null) {
            const l = parseLinks(view.state.doc.toString()).find((x) => pos >= x.from && pos <= x.to && x.id);
            if (l?.id) {
              o.open(l.id, { newTab: true });
              return true;
            }
          }
        }
        return false;
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
  return new EditorView({ parent: o.parent, state: EditorState.create({ doc: o.doc, extensions }) });
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
  view.dispatch({ changes: { from: a, to: cur.length - b, insert: text.slice(a, text.length - b) } });
}
