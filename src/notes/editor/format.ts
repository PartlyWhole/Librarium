/**
 * Formatting commands, as in Obsidian: bold, italic, strikethrough, highlight, code, link,
 * task and heading levels. Each toggles: applied where it isn't, removed where it is (read
 * from the syntax tree, so `**a**` is recognised wherever the cursor is in it). Typing a
 * markup character with text selected wraps the text instead of replacing it.
 */
import { syntaxTree } from "@codemirror/language";
import { EditorSelection, type ChangeSpec, type EditorState, type SelectionRange, type Text } from "@codemirror/state";
import { EditorView, type Command } from "@codemirror/view";
import { startCompletion } from "@codemirror/autocomplete";
import type { SyntaxNode } from "@lezer/common";

/** The inline constructs that toggle, with their node, mark node and the mark to write. */
const INLINE = {
  bold: { node: "StrongEmphasis", mark: "EmphasisMark", text: "**" },
  italic: { node: "Emphasis", mark: "EmphasisMark", text: "*" },
  strike: { node: "Strikethrough", mark: "StrikethroughMark", text: "~~" },
  highlight: { node: "Highlight", mark: "HighlightMark", text: "==" },
  code: { node: "InlineCode", mark: "CodeMark", text: "`" },
} as const;
type InlineFormat = keyof typeof INLINE;

/** The innermost node of a type around [from, to]. */
function around(state: EditorState, from: number, to: number, name: string): SyntaxNode | null {
  for (const side of [1, -1] as const) {
    for (let n: SyntaxNode | null = syntaxTree(state).resolveInner(from, side); n; n = n.parent) {
      if (n.name === name && n.from <= from && n.to >= to) return n;
    }
  }
  return null;
}

/** Toggles an inline format on every selection. */
function toggleInline(kind: InlineFormat): Command {
  const f = INLINE[kind];
  return (view) => {
    const { state } = view;
    const tx = state.changeByRange((r) => {
      const node = around(state, r.from, r.to, f.node);
      if (node) {
        // Remove the construct's own marks (its first and last mark children).
        const marks: SyntaxNode[] = [];
        for (let c = node.firstChild; c; c = c.nextSibling) if (c.name === f.mark) marks.push(c);
        const open = marks[0];
        const close = marks[marks.length - 1];
        if (!open || !close || open === close) return { range: r };
        const changes: ChangeSpec[] = [{ from: open.from, to: open.to }, { from: close.from, to: close.to }];
        const shift = (p: number) => p - (p > open.from ? Math.min(p, open.to) - open.from : 0) - (p > close.from ? Math.min(p, close.to) - close.from : 0);
        return { changes, range: EditorSelection.range(shift(r.anchor), shift(r.head)) };
      }
      const m = f.text;
      if (r.empty) return { changes: { from: r.from, insert: m + m }, range: EditorSelection.cursor(r.from + m.length) };
      return { changes: [{ from: r.from, insert: m }, { from: r.to, insert: m }], range: EditorSelection.range(r.anchor + m.length, r.head + m.length) };
    });
    view.dispatch(state.update(tx, { userEvent: "input.format", scrollIntoView: true }));
    return true;
  };
}

const URLISH = /^(https?:\/\/|mailto:)\S+$/i;

/** ⌘K: a selection becomes `[text](|)`, an address `[|](address)`; with nothing selected,
 * `[[` opens the link picker. */
const insertLink: Command = (view) => {
  const { state } = view;
  if (state.selection.ranges.every((r) => r.empty)) {
    view.dispatch(state.update(state.replaceSelection("[[]]"), { userEvent: "input" }));
    const at = view.state.selection.main.head - 2;
    view.dispatch({ selection: EditorSelection.cursor(at) });
    startCompletion(view);
    return true;
  }
  const tx = state.changeByRange((r) => {
    const text = state.sliceDoc(r.from, r.to);
    if (URLISH.test(text.trim())) return { changes: { from: r.from, to: r.to, insert: `[](${text.trim()})` }, range: EditorSelection.cursor(r.from + 1) };
    const insert = `[${text}]()`;
    return { changes: { from: r.from, to: r.to, insert }, range: EditorSelection.cursor(r.from + insert.length - 1) };
  });
  view.dispatch(state.update(tx, { userEvent: "input.format", scrollIntoView: true }));
  return true;
};

/** The lines a selection range covers. */
function linesOf(doc: Text, r: SelectionRange): number[] {
  const out: number[] = [];
  for (let l = doc.lineAt(r.from).number; l <= doc.lineAt(r.to).number; l++) out.push(l);
  return out;
}

/** Changes every selected line once (several ranges on one line count once). */
function perLine(view: EditorView, change: (text: string) => string | null): boolean {
  const { state } = view;
  const seen = new Set<number>();
  const changes: ChangeSpec[] = [];
  for (const r of state.selection.ranges) {
    for (const n of linesOf(state.doc, r)) {
      if (seen.has(n)) continue;
      seen.add(n);
      const line = state.doc.line(n);
      const next = change(line.text);
      if (next !== null && next !== line.text) changes.push({ from: line.from, to: line.to, insert: next });
    }
  }
  if (!changes.length) return false;
  view.dispatch(state.update({ changes, userEvent: "input.format", scrollIntoView: true }));
  return true;
}

/** ⌘L: a task is ticked or unticked; a list item or a line becomes a task. */
const toggleTask: Command = (view) =>
  perLine(view, (t) => {
    let m = /^(\s*(?:[-*+]|\d+[.)])\s+)\[( |x|X)\](\s?)(.*)$/.exec(t);
    if (m) return `${m[1]}[${m[2] === " " ? "x" : " "}]${m[3] || " "}${m[4]}`;
    m = /^(\s*(?:[-*+]|\d+[.)])\s+)(.*)$/.exec(t);
    if (m) return `${m[1]}[ ] ${m[2]}`;
    const indent = /^\s*/.exec(t)![0];
    return `${indent}- [ ] ${t.slice(indent.length)}`;
  });

/** ⌥⌘1–6: the line becomes a heading of that level (again: back to body text); ⌥⌘0: body text. */
function setHeading(level: number): Command {
  return (view) => {
    const lines = new Set(view.state.selection.ranges.flatMap((r) => linesOf(view.state.doc, r)));
    // Pressed again on headings of that level: they go back to body text.
    const all = [...lines].every((n) => new RegExp(`^#{${level}} `).test(view.state.doc.line(n).text));
    return perLine(view, (t) => {
      const body = t.replace(/^#{1,6}\s+/, "");
      return level === 0 || all ? body : `${"#".repeat(level)} ${body}`;
    });
  };
}

/** Typing one of these with text selected wraps it (as `*`, `_`, `=`, `` ` ``, `~` do). */
const WRAPS: Record<string, string> = { "*": "*", _: "_", "=": "=", "`": "`", "~": "~" };

export const wrapOnType = EditorView.inputHandler.of((view, _from, _to, text) => {
  const close = WRAPS[text];
  const { state } = view;
  if (!close || state.selection.ranges.some((r) => r.empty) || state.readOnly) return false;
  const tx = state.changeByRange((r) => ({
    changes: [{ from: r.from, insert: text }, { from: r.to, insert: close }],
    range: EditorSelection.range(r.anchor + text.length, r.head + text.length),
  }));
  view.dispatch(state.update(tx, { userEvent: "input.type" }));
  return true;
});

/** The formatting keys (before CodeMirror's own, so ⌘L is a task, not "select line"). */
export const formatKeymap = [
  { key: "Mod-b", run: toggleInline("bold") },
  { key: "Mod-i", run: toggleInline("italic") },
  { key: "Mod-Shift-x", run: toggleInline("strike") },
  { key: "Mod-Shift-h", run: toggleInline("highlight") },
  { key: "Mod-e", run: toggleInline("code") },
  { key: "Mod-k", run: insertLink },
  { key: "Mod-l", run: toggleTask },
  ...[0, 1, 2, 3, 4, 5, 6].map((n) => ({ key: `Mod-Alt-${n}`, run: setHeading(n) })),
];

/** The formatting commands by name (for the Format menu and the palette). */
export const FORMATS: { id: string; title: string; keys: string; run: Command }[] = [
  { id: "bold", title: "Bold", keys: "Mod+B", run: toggleInline("bold") },
  { id: "italic", title: "Italic", keys: "Mod+I", run: toggleInline("italic") },
  { id: "strike", title: "Strikethrough", keys: "Mod+Shift+X", run: toggleInline("strike") },
  { id: "highlight", title: "Highlight", keys: "Mod+Shift+H", run: toggleInline("highlight") },
  { id: "code", title: "Code", keys: "Mod+E", run: toggleInline("code") },
  { id: "link", title: "Link", keys: "Mod+K", run: insertLink },
  { id: "task", title: "Task", keys: "Mod+L", run: toggleTask },
  ...[1, 2, 3, 4, 5, 6].map((n) => ({ id: `heading${n}`, title: `Heading ${n}`, keys: `Mod+Alt+${n}`, run: setHeading(n) })),
  { id: "body", title: "Body text", keys: "Mod+Alt+0", run: setHeading(0) },
];
