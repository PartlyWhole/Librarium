/**
 * Editing a capture's parts in a book: each text part on the page shown gets handles at its
 * ends (pictures are whole), and dragging an end into the page's edge turns the page within
 * the chapter.
 */
import { caretIn, rangeEditor, type Edges } from "../handles";
import type { EditedPart, EditPart, PartsEditor } from "../types";
import { zoomOf } from "./pages";
import type { BookView, Frame, Places } from "./places";

/**
 * `frame` is the book's whole area (the handles' overlay); `relayouts` are run when the page
 * shown changes, so the handles are placed again.
 */
export function editBookParts(b: BookView, p: Places, frame: HTMLElement, relayouts: Set<() => void>, parts: EditPart[], onChange: (part: EditedPart) => void): PartsEditor {
  let cur = parts.map((x) => ({ ...x }));
  let editors: { destroy(): void }[] = [];
  let dragging = false;
  const build = () => {
    editors.forEach((e) => e.destroy());
    editors = [];
    for (const part of cur) {
      const spot = !part.region && part.cfi ? p.resolveCFI(part.cfi) : null;
      const f = spot && b.frames().find((x) => x.index === spot.index && x.el.style.visibility !== "hidden");
      if (!spot || !f) continue;
      let range: Range;
      try {
        range = spot.range(f.doc);
      } catch {
        continue;
      }
      editors.push(rangeEditor({
        overlay: frame,
        range,
        screenRects: (r) => p.screenRects(f, r),
        caretAt: (x, y) => {
          const r = f.el.getBoundingClientRect();
          const el = f.doc.scrollingElement ?? f.doc.documentElement;
          const z = zoomOf(f.doc);
          // Window → the page's own measuring units; the browser hit-tests in the frame's pixels.
          const mx = (x - r.left + el.scrollLeft) / z - el.scrollLeft;
          const my = (y - r.top + el.scrollTop) / z - el.scrollTop;
          return f.doc.body ? caretIn(f.doc, f.doc.body, mx, my, { x: x - r.left, y: y - r.top }) : null;
        },
        onDrag: (r) => ((dragging = true), onChange({ key: part.key, done: false, text: p.selOf(f, r) })),
        onDone: (r) => {
          dragging = false;
          const t = p.selOf(f, r);
          part.cfi = t.cfi;
          onChange({ key: part.key, done: true, text: t });
        },
        edges: dragEdges(b, frame, f),
      }));
    }
  };
  const relayout = () => !dragging && build();
  relayouts.add(relayout);
  build();
  return {
    update(next) {
      cur = next.map((x) => ({ ...x }));
      build();
    },
    stop() {
      relayouts.delete(relayout);
      editors.forEach((e) => e.destroy());
      editors = [];
    },
  };
}

/**
 * Dragging a passage's end into the book's left or right edge turns the page (after a moment,
 * then again while held), within the chapter: a passage can't span two chapters. Scrolling,
 * the edges are the top and bottom, and the page scrolls.
 */
function dragEdges(b: BookView, frame: HTMLElement, f: Frame): Edges {
  const el = () => f.doc.scrollingElement ?? f.doc.documentElement;
  return {
    bounds: () => b.stage.getBoundingClientRect(),
    margin: 36,
    delay: b.scrolling() ? 0 : 450,
    repeat: b.scrolling() ? 30 : 900,
    armed: (dx) => {
      frame.classList.toggle("armed-next", !b.scrolling() && dx > 0);
      frame.classList.toggle("armed-prev", !b.scrolling() && dx < 0);
    },
    nudge: async (dx, dy) => {
      const e = el();
      if (b.scrolling()) return void (dy && (e.scrollTop += dy * 24));
      if (!dx || (dx > 0 && e.scrollLeft + e.clientWidth >= e.scrollWidth - 2) || (dx < 0 && e.scrollLeft <= 0)) return;
      const nav = b.nav();
      await new Promise<void>((res) => (dx > 0 ? nav.goRight(false, () => res()) : nav.goLeft(false, () => res())));
      await new Promise((r) => setTimeout(r, 80));
    },
  };
}
