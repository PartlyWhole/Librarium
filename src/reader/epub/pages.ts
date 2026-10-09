/**
 * Measuring and searching inside a book's pages (Readium's frames): zoom-aware positions, text
 * matches, when a page has settled, and pictures as PNGs.
 */

/** Marks and find hits, drawn with the CSS Custom Highlight API inside each page. */
export const HIGHLIGHT_CSS = `
::highlight(lib-saved) { background-color: rgb(255 196 0 / 30%); }
::highlight(lib-pending) { background-color: rgb(255 196 0 / 55%); }
::highlight(lib-find) { background-color: rgb(255 200 0 / 40%); }
::highlight(lib-find-now) { background-color: rgb(255 130 0 / 60%); }
::highlight(lib-show) { background-color: rgb(255 196 0 / 50%); }
`;

/**
 * How much to scale positions measured inside a book page to get pixels. Readium sizes text
 * with CSS zoom on the page body. WebKit then reports positions inside it in its own unzoomed
 * units (with the scroll offset added unscaled: on screen = (x + scroll) × zoom − scroll), while
 * browsers following the newer zoom rules report pixels. Telling them apart: the body measures
 * the page's scroll size divided by the zoom in the old model, and the scroll size itself in
 * the new one.
 */
export function zoomOf(doc: Document): number {
  const body = doc.body;
  if (!body) return 1;
  const z = Number.parseFloat(getComputedStyle(body).zoom) || 1;
  if (z === 1) return 1;
  const el = doc.scrollingElement ?? doc.documentElement;
  const b = body.getBoundingClientRect();
  const wide = el.scrollWidth > el.clientWidth * 1.5;
  const ratio = wide ? el.scrollWidth / (b.width || 1) : el.scrollHeight / (b.height || 1);
  return Math.abs(ratio - z) < Math.abs(ratio - 1) ? z : 1;
}

/** A measured x (relative to the frame) as pixels on screen within the frame. */
export function onScreenX(doc: Document, x: number): number {
  const el = doc.scrollingElement ?? doc.documentElement;
  return (x + el.scrollLeft) * zoomOf(doc) - el.scrollLeft;
}

export function onScreenY(doc: Document, y: number): number {
  const el = doc.scrollingElement ?? doc.documentElement;
  return (y + el.scrollTop) * zoomOf(doc) - el.scrollTop;
}

/** A query as a pattern: case-insensitive, any run of spaces matching any whitespace. */
export function queryPattern(q: string): RegExp {
  const esc = q.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
  return new RegExp(esc, "giu");
}

/** Ranges of a query's matches in a page's text (not in scripts or styles), in order. */
export function findInDoc(doc: Document, query: string): Range[] {
  const root = doc.body ?? doc.documentElement;
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement?.closest("script, style, head") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  const nodes: Text[] = [];
  const starts: number[] = [];
  let text = "";
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    nodes.push(n as Text);
    starts.push(text.length);
    text += (n as Text).data;
  }
  const out: Range[] = [];
  if (!nodes.length || !query.trim()) return out;
  const at = (offset: number): [Text, number] => {
    let lo = 0;
    let hi = nodes.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid]! <= offset) lo = mid;
      else hi = mid - 1;
    }
    return [nodes[lo]!, offset - starts[lo]!];
  };
  const re = queryPattern(query);
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (!m[0].length) {
      re.lastIndex++;
      continue;
    }
    const r = doc.createRange();
    r.setStart(...at(m.index));
    r.setEnd(...at(m.index + m[0].length));
    out.push(r);
  }
  return out;
}

/**
 * When a book page has finished laying out: its fonts and pictures loaded (each up to two
 * seconds), then two frames. A page keeps moving while these arrive, so a place measured
 * earlier can be pages off.
 */
export async function laidOut(doc: Document): Promise<void> {
  const cap = <T,>(p: Promise<T>) => Promise.race([p, new Promise((r) => setTimeout(r, 2000))]);
  await cap(doc.fonts?.ready ?? Promise.resolve());
  const pending = [...doc.images].filter((i) => !i.complete);
  await cap(Promise.all(pending.map((i) => new Promise((r) => (i.addEventListener("load", r, { once: true }), i.addEventListener("error", r, { once: true }))))));
  const win = doc.defaultView;
  if (win) await new Promise((r) => win.requestAnimationFrame(() => win.requestAnimationFrame(r)));
}

/** The picture a range holds on its own (an image, or an SVG's image), if any. */
export function pictureIn(range: Range): HTMLImageElement | SVGImageElement | null {
  const root = range.commonAncestorContainer;
  const el = root.nodeType === Node.ELEMENT_NODE ? (root as Element) : root.parentElement;
  const pics = [...(el?.querySelectorAll("img, image") ?? [])].filter((p) => range.intersectsNode(p));
  if (el && (el.localName === "img" || el.localName === "image") && !pics.length) pics.push(el);
  return (pics[0] as HTMLImageElement | SVGImageElement | undefined) ?? null;
}

/** A picture in a book page as a PNG (its own pixels, at its natural size up to 2,000 px). */
export function pictureToPng(pic: HTMLImageElement | SVGImageElement): string | null {
  const img = pic instanceof HTMLImageElement ? pic : null;
  const w = img?.naturalWidth || pic.getBoundingClientRect().width;
  const h = img?.naturalHeight || pic.getBoundingClientRect().height;
  if (!w || !h) return null;
  const k = Math.min(1, 2000 / Math.max(w, h));
  const c = document.createElement("canvas");
  c.width = Math.round(w * k);
  c.height = Math.round(h * k);
  try {
    c.getContext("2d")!.drawImage(pic as CanvasImageSource, 0, 0, c.width, c.height);
    return c.toDataURL("image/png");
  } catch {
    return null;
  }
}
