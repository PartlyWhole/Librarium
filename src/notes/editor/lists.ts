/**
 * Lists, as in Obsidian: Tab and ⇧Tab move a list item with everything under it, by the width
 * of its parent's marker (so items under "1." line up with its text), and numbered lists are
 * renumbered after. Wrapped lines of an item hang under its text, not under its marker.
 * List indentation is written as spaces only, whatever the indent unit (a tab, for Tab outside
 * lists); tabs already there count as four columns and become spaces when an item moves.
 */
import { insertNewlineAndIndent } from "@codemirror/commands";
import { deleteMarkupBackward, insertNewlineContinueMarkup } from "@codemirror/lang-markdown";
import { syntaxTree } from "@codemirror/language";
import { countColumn, Prec, RangeSetBuilder, type ChangeSpec, type EditorState, type Transaction } from "@codemirror/state";
import { Decoration, keymap, ViewPlugin, type Command, type DecorationSet, type EditorView, type ViewUpdate } from "@codemirror/view";
import type { SyntaxNode } from "@lezer/common";

/** Tabs stop every four columns, as in indent.ts. */
const TAB = 4;

/** The list item starting on a line, if any. */
function itemOn(state: EditorState, lineNo: number): SyntaxNode | null {
  const line = state.doc.line(lineNo);
  const at = line.from + (/^\s*/.exec(line.text)![0].length);
  for (let n: SyntaxNode | null = syntaxTree(state).resolveInner(at, 1); n; n = n.parent) {
    if (n.name === "ListItem" && state.doc.lineAt(n.from).number === lineNo) return n;
  }
  return null;
}

/** Where an item's text starts, as a column (its indentation, marker and the space after). */
function contentColumn(state: EditorState, item: SyntaxNode): number {
  const line = state.doc.lineAt(item.from);
  const m = /^(\s*)([-*+]|\d+[.)])(\s+)/.exec(line.text);
  return m ? countColumn(m[0], TAB) : 0;
}

/** A line's indentation, in columns. */
function indentOf(state: EditorState, lineNo: number): number {
  return countColumn(/^\s*/.exec(state.doc.line(lineNo).text)![0], TAB);
}

/** Moves an item's lines by `by` columns, rewriting their indentation as spaces (blank lines are
 * left empty). */
function shift(state: EditorState, item: SyntaxNode, by: number, changes: ChangeSpec[]): void {
  for (const l of linesOf(state, item)) {
    const line = state.doc.line(l);
    const ws = /^\s*/.exec(line.text)![0];
    const insert = ws.length === line.length ? "" : " ".repeat(Math.max(0, indentOf(state, l) + by));
    if (insert !== ws) changes.push({ from: line.from, to: line.from + ws.length, insert });
  }
}

/** The top items whose first line is selected (an item inside another selected one is carried). */
function selectedItems(state: EditorState): SyntaxNode[] {
  const out: SyntaxNode[] = [];
  for (const r of state.selection.ranges) {
    for (let l = state.doc.lineAt(r.from).number; l <= state.doc.lineAt(r.to).number; l++) {
      const it = itemOn(state, l);
      if (it && !out.some((o) => o.from <= it.from && o.to >= it.to)) out.push(it);
    }
  }
  return out;
}

function linesOf(state: EditorState, n: SyntaxNode): number[] {
  const a = state.doc.lineAt(n.from).number;
  // An item's range can end at the start of the next line: don't take that line.
  const end = state.doc.lineAt(Math.max(n.from, n.to - (state.sliceDoc(n.to - 1, n.to) === "\n" ? 1 : 0))).number;
  const out: number[] = [];
  for (let l = a; l <= end; l++) out.push(l);
  return out;
}

/** The previous item in the same list, if any. */
function previousSibling(n: SyntaxNode): SyntaxNode | null {
  for (let p = n.prevSibling; p; p = p.prevSibling) if (p.name === "ListItem") return p;
  return null;
}

/** Tab on a list item: it (and what's under it) moves under the item before it. */
const indentListItem: Command = (view) => {
  const { state } = view;
  const items = selectedItems(state);
  if (!items.length) return false;
  const changes: ChangeSpec[] = [];
  for (const it of items) {
    const prev = previousSibling(it);
    if (!prev) continue; // the first item has nothing to go under
    const by = contentColumn(state, prev) - indentOf(state, state.doc.lineAt(it.from).number);
    if (by <= 0) continue;
    shift(state, it, by, changes);
  }
  if (changes.length) {
    view.dispatch({ changes, userEvent: "input.indent" });
    renumber(view);
  }
  return true;
};

/** ⇧Tab on a list item: it (and what's under it) moves out, to its parent's level. */
const outdentListItem: Command = (view) => {
  const { state } = view;
  const items = selectedItems(state);
  if (!items.length) return false;
  const changes: ChangeSpec[] = [];
  for (const it of items) {
    const parentItem = it.parent?.parent;
    if (parentItem?.name !== "ListItem") continue; // already at the top
    const by = indentOf(state, state.doc.lineAt(it.from).number) - indentOf(state, state.doc.lineAt(parentItem.from).number);
    if (by <= 0) continue;
    shift(state, it, -by, changes);
  }
  if (changes.length) {
    view.dispatch({ changes, userEvent: "input.indent" });
    renumber(view);
  }
  return true;
};

/**
 * Enter in a list or quote continues it, as lang-markdown does (or, in a list line's indentation,
 * as plain Enter does), but the indentation they build from the indent unit, a tab, is rewritten
 * as spaces, and a blank line they leave, such as the one that makes a list loose, is empty.
 */
const continueMarkup: Command = (view) => {
  const { state } = view;
  let tr: Transaction | undefined;
  const target = { state, dispatch: (t: Transaction) => (tr = t) };
  const inList = state.selection.ranges.every((r) => itemOn(state, state.doc.lineAt(r.head).number));
  if (!insertNewlineContinueMarkup(target) && !(inList && insertNewlineAndIndent(target))) return false;
  if (!tr) return false;
  const changes: ChangeSpec[] = [];
  tr.changes.iterChanges((from, to, _f, _t, text) => {
    const lines = text.toJSON();
    const line = state.doc.lineAt(from);
    // Whitespace left before the new line break would be a blank line: take it too.
    if (lines.length > 1 && !/\S/.test(state.sliceDoc(line.from, from))) from = line.from;
    const atStart = from === line.from;
    const insert = lines.map((s, i) => {
      if (i === 0 && !atStart) return s; // the end of the line Enter was pressed on
      const ws = /^[ \t]*/.exec(s)![0];
      if (ws.length === s.length && i < lines.length - 1) return ""; // a whole line, blank
      return " ".repeat(countColumn(ws, TAB)) + s.slice(ws.length);
    });
    changes.push({ from, to, insert: insert.join(state.lineBreak) });
  });
  const set = state.changes(changes);
  // The cursor ends at or after the inserted text: take it back to before, then past the new text.
  const selection = tr.selection!.map(tr.changes.invertedDesc).map(set, 1);
  view.dispatch({ changes: set, selection, scrollIntoView: true, userEvent: "input" });
  return true;
};

/** Numbers every numbered list in order: a top-level list keeps its first number, a nested
 * one starts at 1. */
function renumber(view: EditorView): void {
  const { state } = view;
  const changes: ChangeSpec[] = [];
  syntaxTree(state).iterate({
    enter(n) {
      if (n.name !== "OrderedList") return undefined;
      let i = 0;
      let first = 1;
      for (let c = n.node.firstChild; c; c = c.nextSibling) {
        if (c.name !== "ListItem") continue;
        const mark = c.firstChild;
        if (!mark || mark.name !== "ListMark") continue;
        const text = state.sliceDoc(mark.from, mark.to);
        const m = /^(\d+)([.)])$/.exec(text);
        if (!m) continue;
        if (i === 0) first = n.node.parent?.name === "ListItem" ? 1 : Number(m[1]);
        const want = `${first + i}${m[2]}`;
        if (want !== text) changes.push({ from: mark.from, to: mark.to, insert: want });
        i++;
      }
      return undefined;
    },
  });
  if (changes.length) view.dispatch({ changes, userEvent: "input.indent" });
}

/** The width of one character of the monospace font, in em (measured once; 0.6 without layout). */
let monoEm = 0;
export function monoWidth(): number {
  if (monoEm) return monoEm;
  monoEm = 0.6;
  if (typeof document === "undefined" || !document.body) return monoEm;
  const probe = document.createElement("span");
  probe.className = "cm-list-prefix";
  probe.style.cssText = "position:absolute;visibility:hidden;white-space:pre;font-size:100px";
  probe.textContent = "0".repeat(20);
  document.body.appendChild(probe);
  const w = probe.getBoundingClientRect().width;
  probe.remove();
  if (w > 0) monoEm = w / 20 / 100;
  return monoEm;
}

/** A task's checkbox, with its margin (as styled for `.cm-task`), in em. */
const CHECKBOX_EM = 1.35;

/**
 * Wrapped lines of a list item hang under its text. The item's indentation and marker are set
 * in the monospace font (so nested items line up at every level, whatever the text's font),
 * and the line's hanging indent is that prefix's width.
 */
export const hangingIndent = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = this.build(view);
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.viewportChanged || u.selectionSet) this.decorations = this.build(u.view);
    }
    build(view: EditorView): DecorationSet {
      const { state } = view;
      const mono = monoWidth();
      const prefix = Decoration.mark({ class: "cm-list-prefix" });
      const b = new RangeSetBuilder<Decoration>();
      for (const { from, to } of view.visibleRanges) {
        for (let pos = from; pos <= to; ) {
          const line = state.doc.lineAt(pos);
          const m = /^(\s*)([-*+]|\d+[.)])(\s+)(\[[ xX]\](\s|$))?/.exec(line.text);
          if (m) {
            // As the live preview shows it: raw while the line is edited; else a dot (or, for
            // a task, its checkbox alone).
            const editing = state.selection.ranges.some((r) => r.from <= line.to && r.to >= line.from);
            const task = !!m[4];
            const em = !editing && task ? m[1]!.length * mono + CHECKBOX_EM + (m[5] ? mono : 0) : m[0].length * mono;
            const w = `${em.toFixed(3)}em`;
            b.add(line.from, line.from, Decoration.line({ attributes: { style: `padding-left: ${w}; text-indent: -${w}` } }));
            b.add(line.from, line.from + m[0].length, prefix);
          }
          pos = line.to + 1;
        }
      }
      return b.finish();
    }
  },
  { decorations: (v) => v.decorations },
);

/** Enter and Backspace in lists and quotes; in place of lang-markdown's own keymap. */
export const markupKeymap = Prec.high(
  keymap.of([
    { key: "Enter", run: continueMarkup },
    { key: "Backspace", run: deleteMarkupBackward },
  ]),
);

export const listKeymap = [
  { key: "Tab", run: indentListItem },
  { key: "Shift-Tab", run: outdentListItem },
];
