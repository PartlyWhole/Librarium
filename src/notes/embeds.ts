/**
 * Embeds in notes: `![[label|id]]` shows its record, except on the line being edited. What it
 * shows depends on the record's kind (one `switch`, `embedFor`), and the same goes for the
 * Markdown it becomes on export (`embedMarkdown`). A record that is missing or archived is left
 * to the live preview, which shows its source with a tooltip.
 *
 * A picture can be given a width, written after the embed as `{width=N}`. Its corner handle
 * sets it, by dragging or with the keys; a double-click goes back to the picture's own size.
 * Each change is one step of the note's undo.
 */
import { syntaxTree } from "@codemirror/language";
import { RangeSetBuilder } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { fileUrl } from "../backend";
import { library } from "../app/library";
import { formatOf, getRecord, isArchived, openRecord, recordIcon, records } from "../app/records";
import { h } from "../ui/dom";
import { icon } from "../ui/icon";
import { effect, untracked } from "../ui/signal";
import type { RecordInfo } from "../types";
import { boardEmbed } from "../boards/cards";
import { captureEmbed, captureMarkdown } from "../captures/embed";
import { parseLinks } from "./editor/links";
import { refreshPreview, refreshed } from "./editor/livepreview";

type Open = (id: string, e: MouseEvent) => void;

/** What an embed shows, and whether it can be resized from its corner. */
interface Shown {
  el: HTMLElement;
  sizable: boolean;
}

/** How each kind of record shows in a note. */
function embedFor(r: RecordInfo, open: Open): Shown {
  switch (r.kind) {
    case "item":
      return formatOf(r) === "image" ? { el: imageEmbed(r, open), sizable: true } : { el: cardEmbed(r, open), sizable: false };
    case "capture":
      return { el: captureEmbed(r, open), sizable: false };
    case "board":
      return { el: boardEmbed(r, open), sizable: true };
    default:
      return { el: cardEmbed(r, open), sizable: false };
  }
}

/** What each kind of record becomes in Export with quotations. */
export function embedMarkdown(r: RecordInfo): string {
  switch (r.kind) {
    case "item":
      return formatOf(r) === "image" ? `![${r.title}](${originalPath(r)})` : `[${r.title}](${r.path})`;
    case "capture":
      return captureMarkdown(r);
    default:
      return `[${r.title || "Untitled"}](${r.path})`;
  }
}

/** An item's original file, relative to the library (`items/<folder>/original.png`). */
const originalPath = (r: RecordInfo) => r.path.replace(/record\.json$/, String(r.fields["library.original"] ?? ""));

function imageEmbed(r: RecordInfo, open: Open): HTMLElement {
  const root = library.peek()?.path ?? "";
  const img = h("img", { class: "embed-image", alt: r.title || "Image", title: r.title, src: fileUrl(`${root}/${originalPath(r)}`), onclick: (e: MouseEvent) => open(r.id, e) });
  img.addEventListener("error", () => (img.alt = `${r.title || "This picture"} (can’t be shown)`), { once: true });
  return h("figure", { class: "embed embed-figure" }, img);
}

function cardEmbed(r: RecordInfo, open: Open): HTMLElement {
  return h("figure", { class: "embed embed-card" }, h("a", { href: "#", class: "list-link", onclick: (e: MouseEvent) => (e.preventDefault(), open(r.id, e)) }, icon(recordIcon(r), 16), " ", r.title || "Untitled"));
}

/** Whether an embed's record can be drawn: it exists and isn't archived. */
export function embedShown(id: string): boolean {
  const r = untracked(() => getRecord(id));
  return !!r && !isArchived(r);
}

// ---- The widget --------------------------------------------------------------------------

/** A width kept after an embed: `{width=320}` (pixels). */
const WIDTH = /^\{width=(\d{1,5})\}/;
const MIN_WIDTH = 48;

/** The width written after the embed ending at `to`, and where it ends. */
function widthAfter(text: string, to: number): { width: number; end: number } | null {
  const m = WIDTH.exec(text.slice(to, to + 16));
  return m ? { width: Number(m[1]), end: to + m[0].length } : null;
}

class EmbedWidget extends WidgetType {
  constructor(readonly r: RecordInfo, readonly width: number | null) {
    super();
  }
  eq(o: EmbedWidget) {
    return o.r.id === this.r.id && o.r.version === this.r.version && o.r.title === this.r.title && o.width === this.width;
  }
  toDOM(view: EditorView) {
    const { el, sizable: canSize } = embedFor(this.r, (id, e) => openRecord(id, {}, { newTab: e.metaKey, again: true }));
    el.classList.add("cm-embed");
    if (canSize) sizable(view, el, this.width, this.r.title || "picture");
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
 * A corner handle on a picture: dragging sets the width (written when let go); ←/→ narrower or
 * wider by 10%, Home the smallest, End and double-click its own size.
 */
function sizable(view: EditorView, el: HTMLElement, width: number | null, name: string) {
  el.classList.add("embed-sizable");
  if (width != null) {
    el.classList.add("embed-sized");
    el.style.width = `${Math.max(MIN_WIDTH, width)}px`;
  }
  const handle = h("span", { class: "embed-resize", tabindex: "0", role: "slider", "aria-label": `Width of ${name}`, "aria-valuemin": String(MIN_WIDTH), title: "Drag to resize · double-click for its own size" });
  const room = () => Math.max(MIN_WIDTH, view.contentDOM.clientWidth - 8);
  const clamp = (w: number) => Math.round(Math.min(room(), Math.max(MIN_WIDTH, w)));
  const shown = () => el.getBoundingClientRect().width;
  handle.addEventListener("focus", () => {
    handle.setAttribute("aria-valuemax", String(Math.round(room())));
    handle.setAttribute("aria-valuenow", String(Math.round(shown())));
    handle.setAttribute("aria-valuetext", width == null ? "Its own size" : `${Math.round(width)} pixels`);
  });
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
    // The picture is drawn again at its new width: the keys stay on its handle.
    requestAnimationFrame(() => view.dom.querySelectorAll(".cm-embed")[nth]?.querySelector<HTMLElement>(".embed-resize")?.focus());
  });
  el.appendChild(handle);
}

function build(view: EditorView): DecorationSet {
  const st = view.state;
  const active = new Set<number>();
  for (const r of st.selection.ranges) for (let n = st.doc.lineAt(r.from).number; n <= st.doc.lineAt(r.to).number; n++) active.add(n);
  const b = new RangeSetBuilder<Decoration>();
  const text = st.doc.toString();
  const all = untracked(records);
  for (const { from, to } of view.visibleRanges) {
    for (const l of parseLinks(text, syntaxTree(st), Math.max(0, from - 2), to)) {
      if (!l.embed || !l.id || l.from < from - 2 || l.from >= to || active.has(st.doc.lineAt(l.from).number)) continue;
      const r = all.get(l.id);
      if (!r || isArchived(r)) continue;
      // With its width, if one is written after it (hidden with it).
      const sized = widthAfter(text, l.to);
      b.add(l.from, sized?.end ?? l.to, Decoration.replace({ widget: new EmbedWidget(r, sized?.width ?? null) }));
    }
  }
  return b.finish();
}

/** The editor extension drawing embeds; they are drawn again when records change. */
export function embedExtension() {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      stop: () => void;
      constructor(view: EditorView) {
        this.decorations = build(view);
        let first = true;
        this.stop = effect(() => {
          records();
          if (first) return void (first = false);
          // Later, never while the editor is updating.
          setTimeout(() => view.dom.isConnected && view.dispatch({ effects: refreshPreview.of(null) }));
        });
      }
      update(u: ViewUpdate) {
        if (u.docChanged || u.viewportChanged || u.selectionSet || refreshed(u)) this.decorations = build(u.view);
      }
      destroy() {
        this.stop();
      }
    },
    { decorations: (v) => v.decorations },
  );
}
