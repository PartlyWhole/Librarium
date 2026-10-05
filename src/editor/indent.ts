/**
 * Indentation (decision 0058): a line's leading tabs and spaces indent it, and are not code.
 * Away from the cursor they are hidden and the line gets a matching left margin, so text,
 * quotes and captures shown in place (which fill the line's width) all move right, and wrapped
 * lines stay under the first. On the line being edited they show as typed. A tab is four
 * columns of the monospace font, as is four spaces; list lines are left to `lists.ts`.
 */
import { RangeSetBuilder } from "@codemirror/state";
import { Decoration, ViewPlugin, type DecorationSet, type EditorView, type ViewUpdate } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import { monoWidth } from "./lists";

const TAB = 4;
const LIST = /^\s*([-*+]|\d+[.)])(\s|$)/;
/** Where leading whitespace is content, not indentation. */
const VERBATIM = new Set(["FencedCode", "HTMLBlock", "CommentBlock", "Table"]);

/** The columns that leading whitespace takes, tabs stopping every four. */
export function indentColumns(ws: string): number {
  let col = 0;
  for (const c of ws) col = c === "\t" ? (Math.floor(col / TAB) + 1) * TAB : col + 1;
  return col;
}

function build(view: EditorView): DecorationSet {
  const { state } = view;
  const mono = monoWidth();
  const tree = syntaxTree(state);
  const hide = Decoration.replace({});
  const raw = Decoration.mark({ class: "cm-indent" });
  const b = new RangeSetBuilder<Decoration>();
  for (const { from, to } of view.visibleRanges) {
    for (let pos = from; pos <= to; ) {
      const line = state.doc.lineAt(pos);
      pos = line.to + 1;
      const ws = /^[ \t]+/.exec(line.text)?.[0];
      if (!ws || ws.length === line.length || LIST.test(line.text)) continue;
      let verbatim = false;
      for (let n: ReturnType<typeof tree.resolve> | null = tree.resolve(line.from + ws.length, 1); n; n = n.parent) {
        if (VERBATIM.has(n.name)) verbatim = true;
      }
      if (verbatim) continue;
      const em = `${(indentColumns(ws) * mono).toFixed(3)}em`;
      const editing = state.selection.ranges.some((r) => r.from <= line.to && r.to >= line.from);
      if (editing) {
        b.add(line.from, line.from, Decoration.line({ attributes: { style: `tab-size: ${(TAB * mono).toFixed(3)}em` } }));
        b.add(line.from, line.from + ws.length, raw);
      } else {
        b.add(line.from, line.from, Decoration.line({ attributes: { style: `margin-left: ${em}` } }));
        b.add(line.from, line.from + ws.length, hide);
      }
    }
  }
  return b.finish();
}

export const indentation = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = build(view);
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.viewportChanged || u.selectionSet || syntaxTree(u.startState) !== syntaxTree(u.state)) this.decorations = build(u.view);
    }
  },
  { decorations: (v) => v.decorations },
);
