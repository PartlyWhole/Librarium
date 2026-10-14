/**
 * Lists, as in Obsidian: Tab and ⇧Tab move a list item with everything under it, by the width
 * of its parent's marker (so items under "1." line up with its text); ⌥↑ and ⌥↓ move it past
 * the item before or after it, also with everything under it; numbered lists are renumbered
 * after each. Enter on an empty item ends the list (or, nested, moves it out a level), at the
 * start of an item's text opens one above, and at the end of an item with items under it opens
 * the first of those; ⇧Enter goes on to a line of the same item. Wrapped lines of an item hang
 * under its text, not under its marker.
 * List indentation is written as spaces only, whatever the indent unit (a tab, for Tab outside
 * lists); tabs already there count as four columns and become spaces when an item moves.
 */
import { insertNewlineAndIndent } from "@codemirror/commands";
import { deleteMarkupBackward, insertNewlineContinueMarkup } from "@codemirror/lang-markdown";
import { syntaxTree } from "@codemirror/language";
import { countColumn, EditorState, Prec, RangeSetBuilder, Transaction, type ChangeSet, type ChangeSpec, type StateCommand, type TransactionSpec } from "@codemirror/state";
import { Decoration, keymap, ViewPlugin, type Command, type DecorationSet, type EditorView, type ViewUpdate } from "@codemirror/view";
import type { SyntaxNode } from "@lezer/common";

/** Tabs stop every four columns, as in indent.ts. */
const TAB = 4;

/** How many quotes a list item is in: its lines are indented after that many quote marks. */
function quoteDepth(item: SyntaxNode): number {
  let depth = 0;
  for (let p = item.parent; p; p = p.parent) if (p.name === "Blockquote") depth++;
  return depth;
}

/** A line's text after `depth` quote marks ("> "). */
function unquoted(state: EditorState, lineNo: number, depth: number): string {
  let text = state.doc.line(lineNo).text;
  for (let i = 0, m; i < depth && (m = /^[ \t]*>[ \t]?/.exec(text)); i++) text = text.slice(m[0].length);
  return text;
}

/** The list item starting on a line, if any. */
function itemOn(state: EditorState, lineNo: number): SyntaxNode | null {
  const line = state.doc.line(lineNo);
  const rest = unquoted(state, lineNo, Infinity);
  const at = line.to - rest.length + /^\s*/.exec(rest)![0].length;
  for (let n: SyntaxNode | null = syntaxTree(state).resolveInner(at, 1); n; n = n.parent) {
    if (n.name === "ListItem" && state.doc.lineAt(n.from).number === lineNo) return n;
  }
  return null;
}

/** Where an item's text starts, as a column (its indentation, marker and the space after). */
function contentColumn(state: EditorState, item: SyntaxNode): number {
  const m = /^(\s*)([-*+]|\d+[.)])(\s+)/.exec(unquoted(state, state.doc.lineAt(item.from).number, quoteDepth(item)));
  return m ? countColumn(m[0], TAB) : 0;
}

/** The indentation of an item's first line (after its quote marks), in columns. */
function indentOf(state: EditorState, item: SyntaxNode): number {
  return columnsOf(unquoted(state, state.doc.lineAt(item.from).number, quoteDepth(item)));
}

function columnsOf(text: string): number {
  return countColumn(/^\s*/.exec(text)![0], TAB);
}

/** Moves an item's lines by `by` columns (the lines under its first by `restBy`), rewriting
 * their indentation (after the item's quote marks) as spaces. Blank lines are left empty. */
function shift(state: EditorState, item: SyntaxNode, by: number, changes: ChangeSpec[], restBy = by): void {
  const depth = quoteDepth(item);
  for (const l of linesOf(state, item)) {
    const line = state.doc.line(l);
    const rest = unquoted(state, l, depth);
    const from = line.to - rest.length;
    const ws = /^\s*/.exec(rest)![0];
    const d = l === state.doc.lineAt(item.from).number ? by : restBy;
    const insert = ws.length === rest.length ? "" : " ".repeat(Math.max(0, columnsOf(rest) + d));
    if (insert !== ws) changes.push({ from, to: from + ws.length, insert });
  }
}

/** An item's marker made like another item's (so it joins that item's list: "-" into "1."), and
 * how much wider it is. Numbers are put right by renumbering after. */
function markLike(state: EditorState, item: SyntaxNode, like: SyntaxNode): { change: ChangeSpec; wider: number } | null {
  const mark = item.firstChild;
  const model = like.firstChild;
  if (mark?.name !== "ListMark" || model?.name !== "ListMark") return null;
  const have = state.sliceDoc(mark.from, mark.to);
  const want = state.sliceDoc(model.from, model.to);
  const numbered = (t: string) => /^\d/.test(t);
  if (numbered(have) ? numbered(want) && have.slice(-1) === want.slice(-1) : have === want) return null;
  return { change: { from: mark.from, to: mark.to, insert: want }, wider: want.length - have.length };
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

function nextSibling(n: SyntaxNode): SyntaxNode | null {
  for (let p = n.nextSibling; p; p = p.nextSibling) if (p.name === "ListItem") return p;
  return null;
}

const isList = (n: SyntaxNode | null | undefined) => n?.name === "BulletList" || n?.name === "OrderedList";

/** The item an item can go under: the one before it in its list, or, for a list's first item,
 * the last of a list just before (a list of the other kind: "1." after "-" starts a new list). */
function itemBefore(n: SyntaxNode): SyntaxNode | null {
  const prev = previousSibling(n);
  if (prev) return prev;
  const before = n.parent?.prevSibling;
  return isList(before) && before!.lastChild?.name === "ListItem" ? before!.lastChild : null;
}

/** The item a position is in (on its first line, or a line under it), if any. */
function itemAt(state: EditorState, pos: number): SyntaxNode | null {
  for (let n: SyntaxNode | null = syntaxTree(state).resolveInner(pos, -1); n; n = n.parent) if (n.name === "ListItem") return n;
  return null;
}

/** An item's first line, split: indentation, marker, the space after, and a task's box. */
const PREFIX = /^(\s*)([-*+]|\d+[.)])(\s+)(\[[ xX]\]\s)?/;

/** Tab on a list item: it (and what's under it) moves under the item before it. */
const indentListItem: Command = (view) => {
  const { state } = view;
  const items = selectedItems(state);
  if (!items.length) return false;
  const changes: ChangeSpec[] = [];
  for (const it of items) {
    const prev = itemBefore(it);
    if (!prev) continue; // the first item has nothing to go under
    // Under items already there, it goes where they are, as one of them.
    const under = isList(prev.lastChild) ? prev.lastChild!.firstChild : null;
    const join = under?.name === "ListItem" ? under : null;
    const by = (join ? indentOf(state, join) : contentColumn(state, prev)) - indentOf(state, it);
    if (by <= 0) continue;
    const mark = join ? markLike(state, it, join) : null;
    shift(state, it, by, changes, by + (mark?.wider ?? 0));
    if (mark) changes.push(mark.change);
  }
  if (changes.length) move(view, changes);
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
    const by = indentOf(state, it) - indentOf(state, parentItem);
    if (by <= 0) continue;
    // It joins its parent's list, as one of its items.
    const mark = markLike(state, it, parentItem);
    shift(state, it, -by, changes, -by + (mark?.wider ?? 0));
    if (mark) changes.push(mark.change);
  }
  if (changes.length) move(view, changes);
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
  // lang-markdown renumbers the items after: one whose number is now a digit wider (9 to 10)
  // takes what is under it along, so it stays under its text.
  const done = tr.state;
  syntaxTree(state).iterate({
    from: state.selection.main.head,
    enter(n) {
      if (n.name !== "ListMark" || !/^\d+[.)]$/.test(state.sliceDoc(n.from, n.to))) return undefined;
      const now = /^\s*(\d+[.)])/.exec(done.doc.lineAt(tr!.changes.mapPos(n.from, 1)).text)?.[1];
      const by = now ? now.length - (n.to - n.from) : 0;
      const it = n.node.parent;
      if (!by || it?.name !== "ListItem") return undefined;
      for (const l of linesOf(state, it).slice(1)) {
        const line = state.doc.line(l);
        const ws = /^[ \t]*/.exec(line.text)![0];
        if (ws && ws.length < line.length) changes.push({ from: line.from, to: line.from + ws.length, insert: " ".repeat(Math.max(0, countColumn(ws, TAB) + by)) });
      }
      return undefined;
    },
  });
  const set = state.changes(changes);
  // The cursor ends at or after the inserted text: take it back to before, then past the new text.
  const selection = tr.selection!.map(tr.changes.invertedDesc).map(set, 1);
  const after = state.update({ changes: set }).state;
  const numbers = after.changes(renumbering(after, changed(set)));
  view.dispatch({ changes: set.compose(numbers), selection: selection.map(numbers), scrollIntoView: true, userEvent: "input" });
  return true;
};

/** Moves items and renumbers the lists they leave and join, as one change (one undo). */
function move(view: EditorView, changes: ChangeSpec[], userEvent = "input.indent", selection?: { anchor: number }): void {
  const moved = view.state.update({ changes, ...(selection ? { selection } : {}) });
  const set = moved.state.changes(renumbering(moved.state, changed(moved.changes)));
  view.dispatch({ changes: moved.changes.compose(set), selection: moved.state.selection.map(set), userEvent, scrollIntoView: true });
}

/** Runs a command, then renumbers the numbered lists it changed, in the same step. */
const renumbered = (cmd: StateCommand): Command => (view) => {
  let tr: Transaction | undefined;
  if (!cmd({ state: view.state, dispatch: (t: Transaction) => (tr = t) }) || !tr) return false;
  const set = tr.state.changes(renumbering(tr.state, changed(tr.changes)));
  view.dispatch({ changes: tr.changes.compose(set), selection: tr.state.selection.map(set), userEvent: tr.annotation(Transaction.userEvent) ?? "delete", scrollIntoView: true });
  return true;
};

/**
 * Enter where lang-markdown's choice isn't Obsidian's: on an empty item (the list ends there:
 * at the top level the marker goes, nested the item moves out a level), at the start of an item's text (an empty item opens above it, with
 * its marker and space, so a lone "-" can't turn the line above into a heading), and at the end
 * of an item with items under it (the first of them opens, rather than a sibling that would take
 * them over). Elsewhere, and in quotes, lang-markdown's own.
 */
const enterInList: Command = (view) => {
  const { state } = view;
  if (state.selection.ranges.length !== 1 || !state.selection.main.empty) return false;
  const pos = state.selection.main.head;
  const line = state.doc.lineAt(pos);
  const item = itemOn(state, line.number);
  const m = PREFIX.exec(line.text);
  // A marker alone on a line under an item's text isn't an item yet (Markdown reads "- " there
  // as more of the text), but it is one being written.
  const bare = !item && /^\s*([-*+]|\d+[.)])\s*$/.test(line.text) ? itemAt(state, line.from) : null;
  if (bare && !quoteDepth(bare) && pos === line.to && columnsOf(line.text) > indentOf(state, bare)) return outOf(view, line, bare);
  if (!item || !m || quoteDepth(item)) return false;
  const start = line.from + m[0].length;
  const text = line.text.slice(m[0].length);
  if (pos < start) return false;
  const parent = item.parent?.parent;
  if (!text.trim()) {
    // Nested, it becomes an item of its parent's list (those after it come under it).
    if (parent?.name === "ListItem") return outOf(view, line, parent);
    view.dispatch({ changes: { from: line.from, to: line.to, insert: "" }, selection: { anchor: line.from }, userEvent: "input", scrollIntoView: true });
    return true;
  }
  // A list numbered "1. 1. 1." goes on so.
  const same = item.parent?.name === "OrderedList" && lazy(state, item.parent);
  if (same && pos > start) {
    const cut = state.sliceDoc(start, pos).replace(/\s+$/, "").length + start;
    const next = `${state.lineBreak}${m[1]}${m[2]}${m[3]}`;
    view.dispatch({ changes: { from: cut, to: pos, insert: next }, selection: { anchor: cut + next.length }, userEvent: "input", scrollIntoView: true });
    return true;
  }
  const blankBox = m[4] ? "[ ] " : "";
  if (pos === start) {
    const above = `${m[1]}${m[2]}${m[3]}${blankBox}`;
    move(view, [{ from: line.from, insert: `${above}${state.lineBreak}` }], "input", { anchor: pos + above.length + state.lineBreak.length });
    return true;
  }
  const under = isList(item.lastChild) ? item.lastChild!.firstChild : null;
  if (pos === line.to && under?.name === "ListItem" && state.doc.lineAt(under.from).number === line.number + 1) {
    const c = PREFIX.exec(state.doc.lineAt(under.from).text);
    if (!c) return false;
    const marker = /\d/.test(c[2]!) ? `1${c[2]!.slice(-1)}` : c[2]!;
    const first = `${state.lineBreak}${c[1]}${marker} ${c[4] ? "[ ] " : ""}`;
    move(view, [{ from: pos, insert: first }], "input", { anchor: pos + first.length });
    return true;
  }
  return false;
};

/** Whether a numbered list is numbered "1. 1. 1." (every item the same). */
function lazy(state: EditorState, list: SyntaxNode): boolean {
  const nums: string[] = [];
  for (let c = list.firstChild; c; c = c.nextSibling) if (c.name === "ListItem" && c.firstChild?.name === "ListMark") nums.push(state.sliceDoc(c.firstChild.from, c.firstChild.to));
  return nums.length > 1 && nums.every((n) => n === nums[0]);
}

/** An empty item (line) made an item of `parent`'s list, after it: its marker, at its indent. */
function outOf(view: EditorView, line: { from: number; to: number }, parent: SyntaxNode): boolean {
  const p = PREFIX.exec(view.state.doc.lineAt(parent.from).text);
  if (!p) return false;
  const n = /^(\d+)([.)])$/.exec(p[2]!);
  const prefix = `${p[1]}${n ? `${Number(n[1]) + 1}${n[2]}` : p[2]}${p[3]}${p[4] ? "[ ] " : ""}`;
  move(view, [{ from: line.from, to: line.to, insert: prefix }], "input", { anchor: line.from + prefix.length });
  return true;
}

/** Backspace just after a task's box: the box goes first (then the marker, as for any item). */
const deleteTaskBox: Command = (view) => {
  const { state } = view;
  if (state.selection.ranges.length !== 1 || !state.selection.main.empty) return false;
  const pos = state.selection.main.head;
  const line = state.doc.lineAt(pos);
  const m = PREFIX.exec(line.text);
  if (!m?.[4] || pos !== line.from + m[0].length) return false;
  view.dispatch({ changes: { from: pos - m[4].length, to: pos }, userEvent: "delete.backward", scrollIntoView: true });
  return true;
};

/** ⇧Enter in a list item: a new line of the same item, under its text. */
const continueItem: Command = (view) => {
  const { state } = view;
  const item = state.selection.ranges.length === 1 ? itemAt(state, state.selection.main.head) : null;
  if (!item || quoteDepth(item)) return false;
  view.dispatch(state.replaceSelection(state.lineBreak + " ".repeat(contentColumn(state, item))), { userEvent: "input", scrollIntoView: true });
  return true;
};

/** ⌥↑ / ⌥↓ on a list item: it and what is under it change places with the item before or
 * after it (and what is under that). At the start or end of its list, it stays. */
const moveItem = (down: boolean): Command => (view) => {
  const { state } = view;
  if (state.selection.ranges.length !== 1) return false;
  const pos = state.selection.main.head;
  const item = itemOn(state, state.doc.lineAt(pos).number) ?? itemAt(state, pos);
  if (!item) return false;
  const other = down ? nextSibling(item) : previousSibling(item);
  if (!other) return true;
  const span = (n: SyntaxNode) => {
    const ls = linesOf(state, n);
    return { from: state.doc.line(ls[0]!).from, to: state.doc.line(ls[ls.length - 1]!).to };
  };
  const [a, b] = down ? [span(item), span(other)] : [span(other), span(item)];
  // The numbers stay in their places (a list keeps the number it starts at).
  const num = (t: string) => /^\s*(\d+[.)])/.exec(t)?.[1];
  const swap = (t: string, n: string | undefined) => (n && num(t) ? t.replace(/^(\s*)\d+[.)]/, `$1${n}`) : t);
  const [x, y] = [state.sliceDoc(a.from, a.to), state.sliceDoc(b.from, b.to)];
  const first = swap(x, num(y));
  const second = swap(y, num(x));
  const between = state.sliceDoc(a.to, b.from);
  const moved = span(item);
  // The cursor keeps its place in the item that moves.
  const at = down ? a.from + second.length + between.length + (pos - moved.from) : a.from + (pos - moved.from);
  move(view, [{ from: a.from, to: b.to, insert: second + between + first }], "move.line", { anchor: at });
  return true;
};

/** Where a change left new text (in the changed document). */
function changed(cs: ChangeSet): { from: number; to: number }[] {
  const out: { from: number; to: number }[] = [];
  cs.iterChangedRanges((_fa, _ta, from, to) => out.push({ from, to }));
  return out;
}

/**
 * Numbers the numbered lists an edit `touched` in order: a top-level list keeps its first number,
 * a nested one starts at 1. A list numbered "1. 1. 1." is left as written, and lists the edit
 * didn't reach are left alone. When a number grows or shrinks a digit (9 to 10), what is under
 * its item moves with its text.
 */
function renumbering(state: EditorState, touched: { from: number; to: number }[]): ChangeSpec[] {
  const changes: ChangeSpec[] = [];
  // Columns each line moves by: a line under several renumbered items adds them up.
  const moves = new Map<number, number>();
  // The lists an edit is in, whole (the outermost list around it, with every list in that).
  const reach = touched.map((t) => {
    let top: SyntaxNode | null = null;
    for (let n: SyntaxNode | null = syntaxTree(state).resolveInner(t.from, 1); n; n = n.parent) if (isList(n)) top = n;
    return top ? { from: Math.min(top.from, t.from), to: Math.max(top.to, t.to) } : t;
  });
  const near = (n: SyntaxNode) => reach.some((t) => n.from <= t.to + 1 && n.to >= t.from - 1);
  const isTouched = (n: SyntaxNode) => touched.some((t) => n.from <= t.to && n.to >= t.from);
  syntaxTree(state).iterate({
    enter(n) {
      if (n.name !== "OrderedList" || !near(n.node)) return undefined;
      const items: { item: SyntaxNode; mark: SyntaxNode; num: number; delim: string }[] = [];
      for (let c = n.node.firstChild; c; c = c.nextSibling) {
        const mark = c.name === "ListItem" ? c.firstChild : null;
        const m = mark?.name === "ListMark" ? /^(\d+)([.)])$/.exec(state.sliceDoc(mark.from, mark.to)) : null;
        if (mark && m) items.push({ item: c, mark, num: Number(m[1]), delim: m[2]! });
      }
      // "1. 1. 1." (as the items the edit didn't reach are numbered) stays so.
      const kept = items.filter((x) => !isTouched(x.mark));
      if (kept.length > 1 && kept.every((x) => x.num === kept[0]!.num)) return undefined;
      const first = n.node.parent?.name === "ListItem" ? 1 : (items[0]?.num ?? 1);
      items.forEach((x, i) => {
        const have = state.sliceDoc(x.mark.from, x.mark.to);
        const want = `${first + i}${x.delim}`;
        if (want === have) return;
        changes.push({ from: x.mark.from, to: x.mark.to, insert: want });
        const lines = linesOf(state, x.item).slice(1);
        for (const l of lines) moves.set(l, (moves.get(l) ?? 0) + want.length - have.length);
      });
      return undefined;
    },
  });
  for (const [l, by] of moves) {
    if (!by) continue;
    const line = state.doc.line(l);
    const ws = /^[ \t]*/.exec(line.text)![0];
    // Blank lines, and lines not indented under the item (a lazy continuation), stay.
    if (ws.length === line.length || !ws) continue;
    changes.push({ from: line.from, to: line.from + ws.length, insert: " ".repeat(Math.max(0, countColumn(ws, TAB) + by)) });
  }
  return changes;
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
            // Under a task, items line up with its text: a checkbox (and the space after it) is
            // wider than the two columns of "- " that the indentation counts.
            let under = 0;
            for (let p = itemOn(state, line.number)?.parent?.parent; p?.name === "ListItem"; p = p.parent?.parent) {
              if (p.getChild("Task")) under += CHECKBOX_EM - mono;
            }
            const w = `${em.toFixed(3)}em`;
            const pad = `${(em + under).toFixed(3)}em`;
            b.add(line.from, line.from, Decoration.line({ attributes: { style: `padding-left: ${pad}; text-indent: -${w}` } }));
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

const LIST_LINE = /^\s*([-*+]|\d+[.)])(\s|$)/;

/**
 * A list pasted onto a list item goes in at that item's level: onto an empty item, in its
 * place; at the end of an item, as the items after it. Its own indentation is kept relative to
 * its first line. Numbered lists are renumbered after.
 */
function pastedList(tr: Transaction): TransactionSpec | null {
  if (!tr.isUserEvent("input.paste") || !tr.docChanged) return null;
  let only: { from: number; to: number; text: string } | null = null;
  let count = 0;
  tr.changes.iterChanges((from, to, _f, _t, text) => ((only = { from, to, text: text.toString() }), count++));
  if (count !== 1 || !only) return null;
  const { from, to, text } = only as { from: number; to: number; text: string };
  const state = tr.startState;
  const lines = text.replace(/\r\n?/g, "\n").replace(/\n+$/, "").split("\n");
  if (!LIST_LINE.test(lines.find((l) => l.trim()) ?? "")) return null;
  const line = state.doc.lineAt(from);
  const item = itemOn(state, line.number);
  const m = PREFIX.exec(line.text);
  if (!item || !m || quoteDepth(item) || from !== to || from !== line.to) return null;
  const empty = !line.text.slice(m[0].length).trim();
  const base = indentOf(state, item);
  const least = Math.min(...lines.filter((l) => l.trim()).map(columnsOf));
  const block = lines.map((l) => (l.trim() ? " ".repeat(base + columnsOf(l) - least) + l.trimStart() : "")).join(state.lineBreak);
  const change = empty ? { from: line.from, to: line.to, insert: block } : { from, insert: state.lineBreak + block };
  const end = (empty ? line.from : from + state.lineBreak.length) + block.length;
  const pasted = state.update({ changes: change, selection: { anchor: end } });
  const numbers = pasted.state.changes(renumbering(pasted.state, changed(pasted.changes)));
  return { changes: pasted.changes.compose(numbers), selection: pasted.state.selection.map(numbers), userEvent: "input.paste", scrollIntoView: true };
}

/**
 * Whole lines deleted from a list: the numbered lists they were in are renumbered, and the items
 * that were under a deleted item's line come up with it (by its depth), so none is left deeper
 * than Markdown reads as a list.
 */
function deletedLines(tr: Transaction): TransactionSpec | null {
  if (!tr.isUserEvent("delete") || !tr.docChanged) return null;
  const state = tr.startState;
  const extra: ChangeSpec[] = [];
  let whole = false;
  tr.changes.iterChanges((from, to) => {
    if (!state.sliceDoc(from, to).includes("\n")) return;
    whole = true;
    // An item whose first line went, and whose lines under it stay: they come up a level.
    const first = state.doc.lineAt(from);
    for (let l = first.number; l <= state.doc.lineAt(to).number; l++) {
      const it = itemOn(state, l);
      const gone = state.doc.line(l);
      // Its first line went, line break and all, but not all of it.
      if (!it || gone.from < from || gone.to >= to || it.to <= to) continue;
      const parentIndent = it.parent?.parent?.name === "ListItem" ? contentColumn(state, it.parent.parent) : 0;
      const by = indentOf(state, it) - contentColumn(state, it);
      for (const k of linesOf(state, it)) {
        const ln = state.doc.line(k);
        if (ln.from < to) continue;
        const ws = /^[ \t]*/.exec(ln.text)![0];
        if (ws && ws.length < ln.length) extra.push({ from: ln.from, to: ln.from + ws.length, insert: " ".repeat(Math.max(parentIndent, countColumn(ws, TAB) + by)) });
      }
    }
  });
  if (!whole) return null;
  // The lifting is in the old document's positions: it goes on after the deletion.
  const lift = state.changes(extra).map(tr.changes);
  const after = tr.state.update({ changes: lift }).state;
  const numbers = after.changes(renumbering(after, changed(tr.changes.compose(lift))));
  if (lift.empty && numbers.empty) return null;
  return { changes: tr.changes.compose(lift).compose(numbers), selection: tr.state.selection.map(lift).map(numbers), userEvent: tr.annotation(Transaction.userEvent) ?? "delete", scrollIntoView: true };
}

/** Pasting and deleting whole lines in lists keep them in order (see above). */
export const listEdits = EditorState.transactionFilter.of((tr) => {
  const spec = pastedList(tr) ?? deletedLines(tr);
  return spec ? [spec] : tr;
});

/** Enter and Backspace in lists and quotes; in place of lang-markdown's own keymap. */
export const markupKeymap = Prec.high(
  keymap.of([
    { key: "Enter", run: (v) => enterInList(v) || continueMarkup(v) },
    { key: "Shift-Enter", run: continueItem },
    { key: "Backspace", run: (v) => deleteTaskBox(v) || renumbered(deleteMarkupBackward)(v) },
    { key: "Alt-ArrowUp", run: moveItem(false) },
    { key: "Alt-ArrowDown", run: moveItem(true) },
  ]),
);

export const listKeymap = [
  { key: "Tab", run: indentListItem },
  { key: "Shift-Tab", run: outdentListItem },
];
