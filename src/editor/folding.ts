/**
 * Folding, as in Obsidian: a small arrow just left of a heading or a list item's bullet (shown
 * when the line is hovered, or while folded); a click folds or unfolds. A folded line ends in a
 * faint "…", and a folded list item's bullet gets a ring. Fold state stays in the editor: it is
 * never written to the file. ⌥⌘[ / ⌥⌘] fold and unfold at the cursor; ⌃⌥[ / ⌃⌥] all.
 */
import { codeFolding, foldEffect, foldKeymap, foldable, foldedRanges, unfoldEffect } from "@codemirror/language";
import { RangeSetBuilder, type EditorState } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, WidgetType, keymap, type DecorationSet, type ViewUpdate } from "@codemirror/view";

/** The folded range starting at the end of a line, if any. */
function foldedAt(state: EditorState, lineTo: number): { from: number; to: number } | null {
  let found: { from: number; to: number } | null = null;
  foldedRanges(state).between(lineTo, lineTo, (from, to) => {
    if (from === lineTo) found = { from, to };
  });
  return found;
}

class Arrow extends WidgetType {
  constructor(readonly folded: boolean, readonly lineFrom: number) {
    super();
  }
  eq(o: Arrow) {
    return o.folded === this.folded && o.lineFrom === this.lineFrom;
  }
  toDOM(view: EditorView) {
    const anchor = document.createElement("span");
    anchor.className = `cm-fold-anchor${this.folded ? " folded" : ""}`;
    const b = document.createElement("span");
    b.className = "cm-fold-arrow";
    b.textContent = "›";
    b.setAttribute("role", "button");
    b.setAttribute("aria-label", this.folded ? "Unfold" : "Fold");
    b.title = this.folded ? "Unfold (⌥⌘])" : "Fold (⌥⌘[)";
    b.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const line = view.state.doc.lineAt(this.lineFrom);
      const done = foldedAt(view.state, line.to);
      if (done) view.dispatch({ effects: unfoldEffect.of(done) });
      else {
        const r = foldable(view.state, line.from, line.to);
        if (r) view.dispatch({ effects: foldEffect.of(r) });
      }
    });
    anchor.appendChild(b);
    return anchor;
  }
  ignoreEvent() {
    return true;
  }
}

const arrows = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = this.build(view);
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.viewportChanged || u.transactions.some((t) => t.effects.length) || foldedRanges(u.startState) !== foldedRanges(u.state)) this.decorations = this.build(u.view);
    }
    build(view: EditorView): DecorationSet {
      const { state } = view;
      const b = new RangeSetBuilder<Decoration>();
      for (const { from, to } of view.visibleRanges) {
        for (let pos = from; pos <= to; ) {
          const line = state.doc.lineAt(pos);
          pos = line.to + 1;
          const list = /^(\s*)([-*+]|\d+[.)])\s/.exec(line.text);
          const heading = /^#{1,6}\s/.test(line.text);
          if (!list && !heading) continue;
          const folded = !!foldedAt(state, line.to);
          if (!folded && !foldable(state, line.from, line.to)) continue;
          // Just left of the bullet (after the indentation), or of the heading.
          const at = line.from + (list ? list[1]!.length : 0);
          if (folded) b.add(line.from, line.from, Decoration.line({ class: "cm-folded-line" }));
          b.add(at, at, Decoration.widget({ widget: new Arrow(folded, line.from), side: -1 }));
        }
      }
      return b.finish();
    }
  },
  { decorations: (v) => v.decorations },
);

export const folding = [
  codeFolding({
    placeholderDOM(_view, onclick) {
      const s = document.createElement("span");
      s.className = "cm-fold-more";
      s.textContent = "…";
      s.title = "Folded: click to unfold";
      s.setAttribute("aria-label", "Folded text");
      s.onclick = onclick;
      return s;
    },
  }),
  arrows,
  keymap.of(foldKeymap),
];
