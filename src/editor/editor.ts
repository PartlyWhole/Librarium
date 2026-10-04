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
import { formatLink, parseLinks } from "./links";
import { formatKeymap, wrapOnType } from "./format";
import { hangingIndent, listKeymap } from "./lists";
import { clipboard, clipboardKeymap } from "./clipboard";
import { codeHighlighting } from "./code";
import { folding } from "./folding";

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
  /** Called after any change of text or selection (debounce it for heavy work). */
  onUpdate?: (view: EditorView) => void;
  /** Makes a note for an unresolved link's words; returns its ID (the link is then completed). */
  create?: (label: string, opts: { newTab: boolean }) => Promise<string | null>;
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
    codeHighlighting,
    ...folding,
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
      if (u.docChanged || u.selectionSet || u.focusChanged) o.onUpdate?.(u.view);
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
        // An unresolved link: make its note (as in Obsidian), complete the link, open it.
        if (t?.dataset.label !== undefined && o.create && !view.state.readOnly) {
          e.preventDefault();
          const pos = view.posAtDOM(t);
          const label = t.dataset.label;
          void o.create(label, { newTab }).then((id) => {
            if (!id) return;
            const l = parseLinks(view.state.doc.toString()).find((x) => !x.id && x.label === label && x.from <= pos && x.to >= pos);
            if (l) view.dispatch({ changes: { from: l.from, to: l.to, insert: formatLink(label, id, l.embed) }, userEvent: "input.link" });
            o.open(id, { newTab });
          });
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
  const view = new EditorView({ parent: o.parent, state: EditorState.create({ doc: o.doc, extensions }) });
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
  view.dispatch({ changes: { from: a, to: cur.length - b, insert: text.slice(a, text.length - b) } });
}
