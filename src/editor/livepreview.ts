/**
 * Live preview, as in Obsidian: Markdown's marks are hidden except on the construct being
 * edited (the emphasis, link or heading the cursor touches), and then shown faintly. Headings,
 * emphasis, highlight, code, quotes, tasks, bullets and links are styled. `[[label|id]]` shows
 * its label; while edited it shows `[[label]]`, the ID hidden and skipped as one unit.
 * Text that isn't markup (bare addresses, `[sic]`, footnote marks) is never hidden.
 */
import { syntaxTree } from "@codemirror/language";
import { RangeSet, RangeSetBuilder, type EditorState, type Range } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import type { SyntaxNode } from "@lezer/common";
import { parseLinks, type Link } from "./links";

/** Marks hidden while their construct isn't being edited. */
const MARKS = new Set(["HeaderMark", "EmphasisMark", "CodeMark", "StrikethroughMark", "HighlightMark", "QuoteMark"]);

/** Whether any selection touches [from, to] (a cursor at either edge counts). */
function touches(state: EditorState, from: number, to: number): boolean {
  return state.selection.ranges.some((r) => r.from <= to && r.to >= from);
}

/** Whether any selection touches the lines of [from, to]. */
function touchesLines(state: EditorState, from: number, to: number): boolean {
  return touches(state, state.doc.lineAt(from).from, state.doc.lineAt(to).to);
}

/** The construct a mark belongs to: its heading or quote line, or its inline parent. */
function construct(state: EditorState, n: SyntaxNode): [number, number] {
  if (n.name === "HeaderMark" || n.name === "QuoteMark") return [state.doc.lineAt(n.from).from, state.doc.lineAt(n.to).to];
  const p = n.parent;
  return p ? [p.from, p.to] : [n.from, n.to];
}

/** A `[…]` that is a real link: inline (`[t](url)`) or a full reference (`[t][ref]`). */
function isRealLink(n: SyntaxNode): boolean {
  for (let c = n.firstChild; c; c = c.nextSibling) if (c.name === "URL" || c.name === "LinkLabel") return true;
  return false;
}

function urlOf(state: EditorState, n: SyntaxNode): string | null {
  for (let c = n.firstChild; c; c = c.nextSibling) if (c.name === "URL") return state.sliceDoc(c.from, c.to);
  return null;
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
    else a.dataset.label = this.link.label;
    a.setAttribute("role", "link");
    a.title = this.link.id ? (this.title && this.title !== this.link.label ? `${this.link.label} → ${this.title}` : this.link.label) : "Not linked to a note yet: click to make it";
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

class BulletWidget extends WidgetType {
  eq() {
    return true;
  }
  toDOM() {
    const s = document.createElement("span");
    s.className = "cm-bullet";
    s.textContent = "•";
    s.setAttribute("aria-hidden", "true");
    return s;
  }
}
const bullet = new BulletWidget();

export interface LivePreviewOptions {
  /** The current title of a linked record (labels are a cache; this is for tooltips). */
  titleOf?: (id: string) => string | null;
  /** Embeds are drawn by an extension (Captures); without one they show as links. */
  embedsHandled?: boolean;
}

interface Built {
  decorations: DecorationSet;
  /** Ranges the cursor moves over as one unit (a link's hidden ID). */
  atomic: RangeSet<Decoration>;
}

const hide = Decoration.replace({});
const dim = Decoration.mark({ class: "cm-mark-dim" });

function build(view: EditorView, opts: LivePreviewOptions): Built {
  const { state } = view;
  const ranges: Range<Decoration>[] = [];
  const atomic: Range<Decoration>[] = [];
  const tree = syntaxTree(state);
  for (const { from, to } of view.visibleRanges) {
    // Wiki links first: what lies inside them is theirs.
    const end = state.doc.lineAt(to).to;
    const wiki = parseLinks(state.sliceDoc(0, end), tree, Math.max(0, from - 2), to).filter((l) => l.to > from && l.from < to);
    const inWiki = (a: number, b: number) => wiki.some((l) => a >= l.from && b <= l.to);
    for (const l of wiki) {
      if (l.embed && opts.embedsHandled) continue;
      if (!touches(state, l.from, l.to)) {
        ranges.push(Decoration.replace({ widget: new LinkWidget(l, l.id && opts.titleOf ? opts.titleOf(l.id) : null) }).range(l.from, l.to));
        continue;
      }
      // Being edited: `[[label]]`, the ID hidden and skipped as one unit.
      ranges.push(Decoration.mark({ class: "cm-wikilink-source" }).range(l.from, l.to));
      if (l.id) {
        const tail = state.sliceDoc(l.from, l.to).lastIndexOf(`|${l.id}`);
        if (tail >= 0) {
          const r = hide.range(l.from + tail, l.from + tail + l.id.length + 1);
          ranges.push(r);
          atomic.push(r);
        }
      }
    }
    tree.iterate({
      from,
      to,
      enter(ref) {
        const n = ref.node;
        const name = n.name;
        if (inWiki(n.from, n.to) && name !== "Paragraph" && name !== "Document") return false;
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
        } else if (name === "TaskMarker") {
          if (!touches(state, n.from, n.to)) {
            const checked = /x/i.test(state.sliceDoc(n.from, n.to));
            ranges.push(Decoration.replace({ widget: new CheckboxWidget(checked) }).range(n.from, n.to));
          }
        } else if (name === "ListMark") {
          // A bullet shows as a dot (a task's bullet not at all) unless its line is edited.
          const mark = state.sliceDoc(n.from, n.to);
          if (/^[-*+]$/.test(mark) && !touchesLines(state, n.from, n.to)) {
            const task = n.nextSibling?.name === "Task";
            const sp = state.sliceDoc(n.to, n.to + 1) === " " ? 1 : 0;
            ranges.push((task ? hide : Decoration.replace({ widget: bullet })).range(n.from, task ? n.to + sp : n.to));
          }
        } else if (name === "Link" || name === "Image") {
          if (name === "Link" && !isRealLink(n)) return false; // [sic], [^1], [!note]: plain text
          const url = urlOf(state, n);
          const editing = touches(state, n.from, n.to);
          ranges.push(Decoration.mark({ class: name === "Image" ? "cm-image-alt" : "cm-md-link", attributes: url ? { "data-url": url } : {} }).range(n.from, n.to));
          // Its marks and address hide unless it is being edited.
          for (let c = n.firstChild; c; c = c.nextSibling) {
            if (c.name !== "LinkMark" && c.name !== "URL" && c.name !== "LinkLabel" && c.name !== "LinkTitle") continue;
            // The text between "[" and "]" stays; everything from "]" on (and "[" / "![") goes.
            if (c.name === "LinkMark" && c.from === n.from) ranges.push((editing ? dim : hide).range(c.from, c.to));
            else if (c.from > n.from) {
              // From the closing "]" to the end: one range.
              ranges.push((editing ? dim : hide).range(c.from, n.to));
              break;
            }
          }
          return false;
        } else if (name === "URL" && n.parent?.name !== "LinkReference") {
          // A bare address or an autolink: shown, styled as a link.
          ranges.push(Decoration.mark({ class: "cm-url", attributes: { "data-url": state.sliceDoc(n.from, n.to) } }).range(n.from, n.to));
        } else if (name === "LinkMark" && n.parent?.name === "Autolink") {
          ranges.push((touches(state, n.parent.from, n.parent.to) ? dim : hide).range(n.from, n.to));
        } else if (MARKS.has(name)) {
          const [a, b] = construct(state, n);
          if (touches(state, a, b)) ranges.push(dim.range(n.from, n.to));
          else {
            // A heading's or quote's mark takes its space with it.
            let e = n.to;
            if ((name === "HeaderMark" || name === "QuoteMark") && state.sliceDoc(e, e + 1) === " ") e++;
            if (e > n.from) ranges.push(hide.range(n.from, e));
          }
        }
        return undefined;
      },
    });
  }
  return { decorations: finish(ranges), atomic: finish(atomic) };
}

/** Sorted, with overlapping replacements dropped (the first one wins). */
function finish(ranges: Range<Decoration>[]): DecorationSet {
  ranges.sort((a, b) => a.from - b.from || a.value.startSide - b.value.startSide);
  const b = new RangeSetBuilder<Decoration>();
  let lastTo = -1;
  for (const r of ranges) {
    const isReplace = r.value.point && r.from < r.to;
    if (isReplace && r.from < lastTo) continue;
    if (!isReplace && r.from < lastTo && r.to <= lastTo && r.value.spec.class === "cm-mark-dim") continue;
    b.add(r.from, r.to, r.value);
    if (isReplace) lastTo = r.to;
  }
  return b.finish();
}

export function livePreview(opts: LivePreviewOptions = {}) {
  const plugin = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      atomic: RangeSet<Decoration>;
      constructor(view: EditorView) {
        ({ decorations: this.decorations, atomic: this.atomic } = build(view, opts));
      }
      update(u: ViewUpdate) {
        if (u.docChanged || u.viewportChanged || u.selectionSet || syntaxTree(u.startState) !== syntaxTree(u.state)) ({ decorations: this.decorations, atomic: this.atomic } = build(u.view, opts));
      }
    },
    {
      decorations: (v) => v.decorations,
      eventHandlers: {
        mousedown(e, view) {
          const t = e.target as HTMLElement;
          // A link to the web opens (the app asks first) unless it is being edited; with ⌘,
          // always. Its words can still be edited from the keyboard, or by clicking beside it.
          const link = t.closest<HTMLElement>("[data-url]");
          if (link && e.button === 0) {
            const pos = view.posAtDOM(link);
            const len = link.textContent?.length ?? 0;
            if (e.metaKey || !touches(view.state, pos, pos + len)) {
              e.preventDefault();
              document.dispatchEvent(new CustomEvent("open-link", { detail: { url: link.dataset.url, text: link.textContent ?? "" } }));
              return true;
            }
          }
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
  return [plugin, EditorView.atomicRanges.of((view) => view.plugin(plugin)?.atomic ?? RangeSet.empty)];
}
