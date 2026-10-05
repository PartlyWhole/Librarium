/**
 * Edit ▸ Undo and Redo (⌘Z, ⇧⌘Z), the app's own, so they are greyed out when there is nothing to
 * undo (macOS's built-in items can't be). They act on what has focus: a note's text through
 * CodeMirror's history, a text field through its own undo. App actions have their own item
 * (Undo the last rename or move).
 */
import { undo, redo, undoDepth, redoDepth } from "@codemirror/commands";
import type { EditorView } from "@codemirror/view";
import { activeEditor, editorChanged } from "../editor/editor";
import { computed, signal, type ReadSignal } from "../kit/signal";

type Target = { editor: EditorView } | { field: HTMLInputElement | HTMLTextAreaElement } | null;

const TEXT_INPUTS = new Set(["text", "search", "url", "email", "tel", "password", "number", ""]);

function target(): Target {
  const ed = activeEditor();
  if (ed?.hasFocus) return { editor: ed };
  const a = document.activeElement;
  if (a instanceof HTMLTextAreaElement || (a instanceof HTMLInputElement && TEXT_INPUTS.has(a.type))) {
    if (!a.readOnly && !a.disabled) return { field: a };
  }
  return null;
}

export interface TextUndo {
  canUndo: ReadSignal<boolean>;
  canRedo: ReadSignal<boolean>;
  undo(): void;
  redo(): void;
}

export function textUndo(): TextUndo {
  // Focus moving between fields changes what Undo acts on.
  const focus = signal(0);
  const bump = () => focus.set(focus.peek() + 1);
  document.addEventListener("focusin", bump);
  document.addEventListener("focusout", () => setTimeout(bump, 0));
  // A field's typing (its undo becomes possible).
  document.addEventListener("input", (e) => {
    if (!(e.target as Element | null)?.closest?.(".cm-editor")) bump();
  });
  const can = (depth: (v: EditorView) => number) =>
    computed(() => {
      editorChanged();
      focus();
      const t = target();
      // A field doesn't say how much it can undo; it may when focused.
      return !!t && ("editor" in t ? depth(t.editor) > 0 : true);
    });
  const act = (cm: (v: EditorView) => boolean, command: "undo" | "redo") => {
    const t = target();
    if (!t) return;
    if ("editor" in t) cm(t.editor);
    else document.execCommand(command);
  };
  return {
    canUndo: can((v) => undoDepth(v.state)),
    canRedo: can((v) => redoDepth(v.state)),
    undo: () => act(({ state, dispatch }) => undo({ state, dispatch }), "undo"),
    redo: () => act(({ state, dispatch }) => redo({ state, dispatch }), "redo"),
  };
}
