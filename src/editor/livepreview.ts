/**
 * Live preview: Markdown syntax is hidden except on the lines being edited. Headings, emphasis,
 * highlight, code, quotes, tasks and links are styled; `[[label|id]]` shows only its label.
 */
import { syntaxTree } from "@codemirror/language";
import { RangeSetBuilder, type EditorState, type Range } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { parseLinks, type Link } from "./links";

/** Hidden on inactive lines. */
const HIDE = new Set(["HeaderMark", "EmphasisMark", "CodeMark", "StrikethroughMark", "HighlightMark", "LinkMark", "URL", "QuoteMark"]);

function activeLines(state: EditorState): Set<number> {
  const s = new Set<number>();
  for (const r of state.selection.ranges) {
    const a = state.doc.lineAt(r.from).number;
    const b = state.doc.lineAt(r.to).number;
    for (let n = a; n <= b; n++) s.add(n);
  }
  return s;
}

class LinkWidget extends WidgetType {
  constructor(readonly link: Link, readonly title: string | null) {
    super();
  }
  eq(o: LinkWidget) {
    return o.link.label === this.link.label && o.link.id === this.link.id && o.title === this.title;
  }
  toDOM() {
    const a = document.createElement("span");
    a.className = `cm-wikilink ${this.link.id ? "" : "unresolved"}`;
    a.textContent = this.link.label || this.title || "Untitled";
    if (this.link.id) a.dataset.id = this.link.id;
    a.setAttribute("role", "link");
    a.title = this.link.id ? (this.title && this.title !== this.link.label ? `${this.link.label} → ${this.title}` : this.link.label) : "Not linked to a record yet";
    return a;
  }
  ignoreEvent() {
    return false;
  }
}

class CheckboxWidget extends WidgetType {
  constructor(readonly checked: boolean) {
    super();
  }
  eq(o: CheckboxWidget) {
    return o.checked === this.checked;
  }
  toDOM() {
    const b = document.createElement("input");
    b.type = "checkbox";
    b.checked = this.checked;
    b.className = "cm-task";
    b.setAttribute("aria-label", this.checked ? "Done" : "To do");
    return b;
  }
  ignoreEvent() {
    return false;
  }
}

export interface LivePreviewOptions {
  /** The current title of a linked record (labels are a cache; this is for tooltips). */
  titleOf?: (id: string) => string | null;
  /** Embeds are drawn by an extension (Captures); without one they show as links. */
  embedsHandled?: boolean;
}

function build(view: EditorView, opts: LivePreviewOptions): DecorationSet {
  const { state } = view;
  const active = activeLines(state);
  const ranges: Range<Decoration>[] = [];
  const tree = syntaxTree(state);
  for (const { from, to } of view.visibleRanges) {
    tree.iterate({
      from,
      to,
      enter(n) {
        const line = state.doc.lineAt(n.from).number;
        const isActive = active.has(line);
        const name = n.name;
        const m = /^ATXHeading(\d)$/.exec(name) ?? /^SetextHeading(\d)$/.exec(name);
        if (m) ranges.push(Decoration.line({ class: `cm-h${m[1]}` }).range(state.doc.lineAt(n.from).from));
        else if (name === "Emphasis") ranges.push(Decoration.mark({ class: "cm-em" }).range(n.from, n.to));
        else if (name === "StrongEmphasis") ranges.push(Decoration.mark({ class: "cm-strong" }).range(n.from, n.to));
        else if (name === "Strikethrough") ranges.push(Decoration.mark({ class: "cm-strike" }).range(n.from, n.to));
        else if (name === "Highlight") ranges.push(Decoration.mark({ class: "cm-highlight" }).range(n.from, n.to));
        else if (name === "InlineCode") ranges.push(Decoration.mark({ class: "cm-inline-code" }).range(n.from, n.to));
        else if (name === "Blockquote") {
          for (let l = state.doc.lineAt(n.from).number; l <= state.doc.lineAt(n.to).number; l++) ranges.push(Decoration.line({ class: "cm-quote" }).range(state.doc.line(l).from));
        } else if (name === "FencedCode" || name === "CodeBlock") {
          for (let l = state.doc.lineAt(n.from).number; l <= state.doc.lineAt(n.to).number; l++) ranges.push(Decoration.line({ class: "cm-code-block" }).range(state.doc.line(l).from));
          return false;
        } else if (name === "Table") {
          for (let l = state.doc.lineAt(n.from).number; l <= state.doc.lineAt(n.to).number; l++) ranges.push(Decoration.line({ class: "cm-table-row" }).range(state.doc.line(l).from));
        } else if (name === "TaskMarker" && !isActive) {
          const checked = /x/i.test(state.sliceDoc(n.from, n.to));
          ranges.push(Decoration.replace({ widget: new CheckboxWidget(checked) }).range(n.from, n.to));
        } else if (HIDE.has(name) && !isActive) {
          // Keep a quote's mark if it's all there is (an empty line); hide the rest.
          let end = n.to;
          if ((name === "HeaderMark" || name === "QuoteMark") && state.sliceDoc(end, end + 1) === " ") end++;
          if (end > n.from) ranges.push(Decoration.replace({}).range(n.from, end));
        }
        return undefined;
      },
    });
    // Wiki links and embeds: label only, except while the cursor is on their line.
    const text = state.sliceDoc(0, state.doc.length);
    for (const l of parseLinks(text, tree, Math.max(0, from - 2), to)) {
      if (l.to <= from || l.from >= to) continue;
      const line = state.doc.lineAt(l.from).number;
      if (l.embed && opts.embedsHandled) continue;
      if (active.has(line)) ranges.push(Decoration.mark({ class: "cm-wikilink-source" }).range(l.from, l.to));
      else ranges.push(Decoration.replace({ widget: new LinkWidget(l, l.id && opts.titleOf ? opts.titleOf(l.id) : null) }).range(l.from, l.to));
    }
  }
  ranges.sort((a, b) => a.from - b.from || a.value.startSide - b.value.startSide);
  const b = new RangeSetBuilder<Decoration>();
  let lastTo = -1;
  for (const r of ranges) {
    // Replacements may not overlap; the first one wins.
    const isReplace = r.value.point && r.from < r.to;
    if (isReplace && r.from < lastTo) continue;
    b.add(r.from, r.to, r.value);
    if (isReplace) lastTo = r.to;
  }
  return b.finish();
}

export function livePreview(opts: LivePreviewOptions = {}) {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = build(view, opts);
      }
      update(u: ViewUpdate) {
        if (u.docChanged || u.viewportChanged || u.selectionSet || syntaxTree(u.startState) !== syntaxTree(u.state)) this.decorations = build(u.view, opts);
      }
    },
    {
      decorations: (v) => v.decorations,
      eventHandlers: {
        mousedown(e, view) {
          const t = e.target as HTMLElement;
          if (t.classList.contains("cm-task")) {
            const pos = view.posAtDOM(t);
            const text = view.state.sliceDoc(pos, pos + 3);
            if (/^\[[ xX]\]$/.test(text)) {
              view.dispatch({ changes: { from: pos + 1, to: pos + 2, insert: text[1] === " " ? "x" : " " } });
              e.preventDefault();
              return true;
            }
          }
          return false;
        },
      },
    },
  );
}
