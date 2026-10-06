/**
 * The editor extension for captures placed in writing: `![[label|id]]` shows as the quotation
 * with its citation, except on the line being edited. A record that can't be shown (archived,
 * or gone) is left to the live preview, which shows its source (0059).
 *
 * A picture (an image, a board) can be given a width: `![[label|id]]{width=320}`, Pandoc's
 * attribute form, kept after the embed so the link's grammar (BRIEF §5.4) is untouched. Its
 * corner handle sets it, by dragging or with the arrow keys; a double-click goes back to the
 * picture's own size (decision 0071).
 */
import { RangeSetBuilder, type EditorState } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import { parseLinks } from "../../editor/links";
import { refreshPreview, refreshed } from "../../editor/livepreview";
import { effect } from "../../kit/signal";
import type { ShellApi } from "../../shell/api";

/** A width kept after an embed: `{width=320}` (pixels). */
const WIDTH = /^\{width=(\d{1,5})\}/;
export const MIN_WIDTH = 48;
/** The width written after the embed that ends at `to`, and where the attribute ends. */
export function widthAfter(text: string, to: number): { width: number; end: number } | null {
  const m = WIDTH.exec(text.slice(to, to + 16));
  return m ? { width: Number(m[1]), end: to + m[0].length } : null;
}

class EmbedWidget extends WidgetType {
  constructor(readonly shell: ShellApi, readonly id: string, readonly label: string, readonly version: string, readonly width: number | null) {
    super();
  }
  eq(o: EmbedWidget) {
    return o.id === this.id && o.version === this.version && o.label === this.label && o.width === this.width;
  }
  toDOM(view: EditorView) {
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
    if (renderer.resizable?.(r)) sizable(view, el, this.width, r.title || "picture");
    return el;
  }
  ignoreEvent() {
    return true;
  }
}

/** Writes a width after the embed drawn by `el` (null: none, the picture's own size). */
function setWidth(view: EditorView, el: HTMLElement, width: number | null) {
  let at: number;
  try {
    at = view.posAtDOM(el);
  } catch {
    return;
  }
  const text = view.state.doc.toString();
  const line = view.state.doc.lineAt(at);
  const l = parseLinks(text, syntaxTree(view.state), line.from, line.to).find((x) => x.embed && x.from === at);
  if (!l) return;
  const old = widthAfter(text, l.to);
  const insert = width == null ? "" : `{width=${Math.round(width)}}`;
  if ((old ? text.slice(l.to, old.end) : "") === insert) return;
  view.dispatch({ changes: { from: l.to, to: old?.end ?? l.to, insert }, userEvent: "input.resize" });
}

/**
 * A corner handle on a picture: drag it to set the width (written when let go, one undo step);
 * ← → narrower or wider by 10%, double-click its own size.
 */
function sizable(view: EditorView, el: HTMLElement, width: number | null, name: string) {
  el.classList.add("embed-sizable");
  if (width != null) {
    el.classList.add("embed-sized");
    el.style.width = `${width}px`;
  }
  const handle = document.createElement("span");
  handle.className = "embed-resize";
  handle.tabIndex = 0;
  handle.setAttribute("role", "slider");
  handle.setAttribute("aria-label", `Width of ${name}`);
  handle.setAttribute("aria-valuemin", String(MIN_WIDTH));
  handle.title = "Drag to resize · double-click for its own size";
  const room = () => Math.max(MIN_WIDTH, view.contentDOM.clientWidth - 8);
  const clamp = (w: number) => Math.round(Math.min(room(), Math.max(MIN_WIDTH, w)));
  const shown = () => el.getBoundingClientRect().width;
  const say = () => {
    handle.setAttribute("aria-valuemax", String(Math.round(room())));
    handle.setAttribute("aria-valuenow", String(Math.round(shown())));
    handle.setAttribute("aria-valuetext", width == null ? "Its own size" : `${Math.round(width)} pixels`);
  };
  handle.addEventListener("focus", say);
  handle.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const x0 = e.clientX;
    const w0 = shown();
    let w = w0;
    handle.setPointerCapture(e.pointerId);
    el.classList.add("embed-resizing");
    const move = (m: PointerEvent) => {
      w = clamp(w0 + m.clientX - x0);
      el.classList.add("embed-sized");
      el.style.width = `${w}px`;
    };
    const up = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      handle.removeEventListener("pointercancel", up);
      el.classList.remove("embed-resizing");
      if (Math.abs(w - w0) >= 2) setWidth(view, el, w);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", up);
  });
  handle.addEventListener("click", (e) => e.stopPropagation());
  handle.addEventListener("dblclick", (e) => {
    e.preventDefault();
    e.stopPropagation();
    setWidth(view, el, null);
  });
  handle.addEventListener("keydown", (e) => {
    const d = e.key === "ArrowRight" || e.key === "ArrowUp" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowDown" ? -1 : 0;
    if (!d && e.key !== "Home" && e.key !== "End") return;
    e.preventDefault();
    e.stopPropagation();
    const nth = [...view.dom.querySelectorAll(".cm-embed")].indexOf(el);
    if (e.key === "Home") setWidth(view, el, MIN_WIDTH);
    else if (e.key === "End") setWidth(view, el, null);
    else setWidth(view, el, clamp(shown() * (d > 0 ? 1.1 : 1 / 1.1)));
    // The picture is drawn again with its new width: keep the keys on its handle.
    requestAnimationFrame(() => view.dom.querySelectorAll(".cm-embed")[nth]?.querySelector<HTMLElement>(".embed-resize")?.focus());
  });
  el.appendChild(handle);
}

/** Whether an embed's record can be drawn: it exists, has a renderer and isn't archived. */
export function embedShown(shell: ShellApi, id: string): boolean {
  const r = shell.records.get(id);
  return !!r && !!shell.embeds.get(r.kind) && r.fields["archive.at"] == null;
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
      if (!embedShown(shell, l.id)) continue;
      const r = shell.records.get(l.id);
      // With its width, if one is kept after it (hidden with it).
      const sized = widthAfter(text, l.to);
      b.add(l.from, sized?.end ?? l.to, Decoration.replace({ widget: new EmbedWidget(shell, l.id, l.label, r?.version ?? "", sized?.width ?? null), block: false, inclusive: false }));
    }
  }
  return b.finish();
}

export function embedExtension(shell: ShellApi) {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      stop: () => void;
      constructor(view: EditorView) {
        this.decorations = build(view, shell);
        // Records archived, restored or changed: draw again (later, never while updating).
        let first = true;
        this.stop = effect(() => {
          shell.records.list();
          if (first) return void (first = false);
          setTimeout(() => view.dom.isConnected && view.dispatch({ effects: refreshPreview.of(null) }));
        });
      }
      update(u: ViewUpdate) {
        if (u.docChanged || u.viewportChanged || u.selectionSet || refreshed(u)) this.decorations = build(u.view, shell);
      }
      destroy() {
        this.stop();
      }
    },
    { decorations: (v) => v.decorations },
  );
}
