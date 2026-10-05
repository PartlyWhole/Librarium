/**
 * The editor extension for captures placed in writing: `![[label|id]]` shows as the quotation
 * with its citation, except on the line being edited.
 */
import { RangeSetBuilder, type EditorState } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import { parseLinks } from "../../editor/links";
import type { ShellApi } from "../../shell/api";

class EmbedWidget extends WidgetType {
  constructor(readonly shell: ShellApi, readonly id: string, readonly label: string, readonly version: string) {
    super();
  }
  eq(o: EmbedWidget) {
    return o.id === this.id && o.version === this.version && o.label === this.label;
  }
  toDOM() {
    const r = this.shell.records.get(this.id);
    const renderer = r ? this.shell.embeds.get(r.kind) : undefined;
    if (!r || !renderer) {
      const s = document.createElement("span");
      s.className = "cm-wikilink unresolved";
      s.textContent = this.label || "A missing capture";
      s.title = "This capture can’t be found";
      return s;
    }
    const el = renderer.render(r, (id, params, opts) => this.shell.openRecord(id, params, { again: true, ...opts }));
    el.classList.add("cm-embed");
    return el;
  }
  ignoreEvent() {
    return true;
  }
}

function build(view: EditorView, shell: ShellApi): DecorationSet {
  const st: EditorState = view.state;
  const active = new Set<number>();
  for (const r of st.selection.ranges) for (let n = st.doc.lineAt(r.from).number; n <= st.doc.lineAt(r.to).number; n++) active.add(n);
  const b = new RangeSetBuilder<Decoration>();
  const text = st.doc.toString();
  for (const { from, to } of view.visibleRanges) {
    for (const l of parseLinks(text, syntaxTree(st), Math.max(0, from - 2), to)) {
      if (!l.embed || !l.id || l.from < from - 2 || l.from >= to) continue;
      const line = st.doc.lineAt(l.from);
      if (active.has(line.number)) continue;
      const r = shell.records.get(l.id);
      const whole = line.text.trim() === text.slice(l.from, l.to).trim();
      b.add(l.from, l.to, Decoration.replace({ widget: new EmbedWidget(shell, l.id, l.label, r?.version ?? ""), block: false, inclusive: false, ...(whole ? {} : {}) }));
    }
  }
  return b.finish();
}

export function embedExtension(shell: ShellApi) {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = build(view, shell);
      }
      update(u: ViewUpdate) {
        if (u.docChanged || u.viewportChanged || u.selectionSet) this.decorations = build(u.view, shell);
      }
    },
    { decorations: (v) => v.decorations },
  );
}
