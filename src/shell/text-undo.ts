/**
 * Edit ▸ Undo and Redo (⌘Z, ⇧⌘Z), the app's own, so they are greyed out when there is nothing to
 * undo (macOS's built-in items can't be). They act on the place being looked at (decision 0060):
 *
 * - a text field with focus (a search box, a title): its own undo;
 * - the sidebar, when it has focus, and every page without a record of its own (Library, Files,
 *   Captures, Archive): the shared "Library & notes" history;
 * - a record's page (a note, a capture, an item): that record's history, typing included;
 * - an editor that belongs to no page (the capture being made): its own typing.
 */
import { undo, redo, undoDepth, redoDepth } from "@codemirror/commands";
import type { EditorView } from "@codemirror/view";
import { activeEditor, editorChanged } from "../editor/editor";
import { computed, signal, type ReadSignal } from "../kit/signal";
import { LIBRARY, recordScope, type Undo } from "./undo";
import type { Route } from "./router";

type Target = { scope: string } | { editor: EditorView } | { field: HTMLInputElement | HTMLTextAreaElement };

const TEXT_INPUTS = new Set(["text", "search", "url", "email", "tel", "password", "number", ""]);

export interface TextUndo {
  canUndo: ReadSignal<boolean>;
  canRedo: ReadSignal<boolean>;
  undo(): void;
  redo(): void;
  /** The place ⌘Z acts on now (for tests and the menu). */
  scope(): string | null;
  /** What Undo / Redo would do, for the Edit menu ("Typing", "rename to …"), when known. */
  undoLabel: ReadSignal<string | null>;
  redoLabel: ReadSignal<string | null>;
}

export function textUndo(app: Undo, route: () => Route): TextUndo {
  // The part of the window last worked in (as in Finder or VS Code): menus and dialogs, which
  // sit outside both, don't change it.
  let region: "sidebar" | "page" | null = null;
  const regionOf = (t: EventTarget | null) => {
    const el = t as Element | null;
    if (el?.closest?.(".app-sidebar")) region = "sidebar";
    else if (el?.closest?.(".workspace")) region = "page";
  };
  document.addEventListener("pointerdown", (e) => (regionOf(e.target), bump()), true);
  document.addEventListener("focusin", (e) => regionOf(e.target), true);
  /** What ⌘Z acts on now. */
  const target = (): Target => {
    const ed = activeEditor();
    if (ed?.hasFocus) {
      const scope = app.scopeOf(ed);
      return scope ? { scope } : { editor: ed };
    }
    const a = document.activeElement;
    if (a instanceof HTMLTextAreaElement || (a instanceof HTMLInputElement && TEXT_INPUTS.has(a.type))) {
      if (!a.readOnly && !a.disabled) return { field: a };
    }
    // The sidebar, when it has the focus, or was the last place clicked (a menu opened from it
    // leaves the focus nowhere).
    if (a?.closest?.(".app-sidebar") || ((!a || a === document.body) && region === "sidebar")) return { scope: LIBRARY };
    const r = route();
    return { scope: r.params.id ? recordScope(r.params.id) : LIBRARY };
  };
  // Focus moving between fields changes what Undo acts on.
  const focus = signal(0);
  const bump = () => focus.set(focus.peek() + 1);
  document.addEventListener("focusin", bump);
  document.addEventListener("focusout", () => setTimeout(bump, 0));
  // A field's typing (its undo becomes possible).
  document.addEventListener("input", (e) => {
    if (!(e.target as Element | null)?.closest?.(".cm-editor")) bump();
  });
  const can = (depth: (v: EditorView) => number, appCan: (scope: string) => boolean) =>
    computed(() => {
      editorChanged();
      focus();
      route();
      const t = target();
      // A field doesn't say how much it can undo; it may when focused.
      if ("field" in t) return true;
      if ("editor" in t) return depth(t.editor) > 0;
      return appCan(t.scope);
    });
  const act = (cm: (v: EditorView) => boolean, command: "undo" | "redo") => {
    const t = target();
    if ("field" in t) return void document.execCommand(command);
    if ("editor" in t) return void cm(t.editor);
    void (command === "undo" ? app.undo(t.scope) : app.redo(t.scope));
  };
  const label = (which: "undo" | "redo") =>
    computed(() => {
      editorChanged();
      focus();
      route();
      const t = target();
      if (!("scope" in t)) return null;
      return which === "undo" ? app.undoLabel(t.scope) : app.redoLabel(t.scope);
    });
  return {
    undoLabel: label("undo"),
    redoLabel: label("redo"),
    canUndo: can((v) => undoDepth(v.state), (s) => app.canUndo(s)),
    canRedo: can((v) => redoDepth(v.state), (s) => app.canRedo(s)),
    undo: () => act(({ state, dispatch }) => undo({ state, dispatch }), "undo"),
    redo: () => act(({ state, dispatch }) => redo({ state, dispatch }), "redo"),
    scope: () => {
      const t = target();
      return "scope" in t ? t.scope : null;
    },
  };
}
