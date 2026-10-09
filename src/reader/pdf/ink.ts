/**
 * Lines up a scanned page's recognised text with the scan.
 *
 * A scanned PDF with recognised text (JSTOR's, and most scanners') draws the page as a picture
 * and lays the text over it invisibly. Often each line is one string in a font unrelated to
 * the scan, with nothing to say where each word is, and of a different length than the
 * printed line. Selections, find matches and captures then land beside the words seen. The
 * only ground truth is the picture: along each line, the words are runs of ink separated by
 * word-sized gaps. Each word of the text is put on its run of ink. If the counts differ
 * (recognition errors), the whole line is stretched from the first ink to the last.
 */

import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";

/** A run of ink along a line: where a printed word is, in canvas pixels. */
interface Ink {
  start: number;
  end: number;
}

/**
 * The words along a band of a canvas: runs of dark columns, joined across gaps narrower than
 * `gapMin` (the spaces between letters).
 */
function inkRuns(data: Uint8ClampedArray, width: number, height: number, gapMin: number, dark = 150): Ink[] {
  const inked: boolean[] = new Array(width).fill(false);
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) {
      const i = (y * width + x) * 4;
      if (0.3 * data[i]! + 0.59 * data[i + 1]! + 0.11 * data[i + 2]! < dark && data[i + 3]! > 64) {
        inked[x] = true;
        break;
      }
    }
  }
  const runs: Ink[] = [];
  let start = -1;
  let gap = 0;
  for (let x = 0; x < width; x++) {
    if (inked[x]) {
      if (start < 0) start = x;
      else if (gap >= gapMin) {
        runs.push({ start, end: x - gap });
        start = x;
      }
      gap = 0;
    } else if (start >= 0) gap++;
  }
  if (start >= 0) runs.push({ start, end: width - gap });
  return runs;
}

/**
 * The printed line around a line of text: from the run of ink nearest the text's start, on
 * through the runs that start before the text's end give or take a quarter of its length (the
 * recognised text is often shorter or longer than the print), and no further apart than
 * `maxGap` (wider than any word space, narrower than a column gap).
 */
function lineInk(runs: Ink[], textStart: number, textEnd: number, near: number, maxGap: number): Ink[] {
  const first = runs.findIndex((r) => r.end >= textStart - near && r.start <= textStart + near);
  if (first < 0) return [];
  const limit = textEnd + Math.max(near, (textEnd - textStart) * 0.25);
  const out = [runs[first]!];
  for (let i = first + 1; i < runs.length && runs[i]!.start <= limit && runs[i]!.start - out[out.length - 1]!.end <= maxGap; i++) out.push(runs[i]!);
  return out;
}

/**
 * Where each word of a line goes, given the words' places now (left, width) and the printed
 * words: one to one when the counts agree, else the line stretched over its ink.
 */
function placeOnInk(words: { left: number; width: number }[], ink: Ink[]): { left: number; width: number }[] | null {
  if (!words.length || !ink.length) return null;
  if (ink.length === words.length) {
    return words.map((_, i) => {
      const r = ink[i]!;
      // A word takes its gap too (up to the next word), so selections run on across spaces.
      const next = ink[i + 1];
      return { left: r.start, width: (next ? next.start : r.end) - r.start };
    });
  }
  const t0 = words[0]!.left;
  const t1 = Math.max(...words.map((w) => w.left + w.width));
  const i0 = ink[0]!.start;
  const i1 = ink[ink.length - 1]!.end;
  // Not onto ink much shorter or longer than the text: that ink is something else.
  if (t1 <= t0 || i1 <= i0 || (i1 - i0) / (t1 - t0) < 0.6 || (i1 - i0) / (t1 - t0) > 1.6) return null;
  const k = (i1 - i0) / (t1 - t0);
  return words.map((w) => ({ left: i0 + (w.left - t0) * k, width: w.width * k }));
}

/**
 * Aligns a page's text layer (its word spans) to the ink of its canvas. Returns how many lines
 * were aligned.
 */
export function alignToInk(pageDiv: HTMLElement): number {
  const layer = pageDiv.querySelector<HTMLElement>(".textLayer");
  const canvas = pageDiv.querySelector<HTMLCanvasElement>("canvas");
  const ctx = canvas?.getContext("2d", { willReadFrequently: true });
  if (!layer || !canvas || !ctx || !canvas.width) return 0;
  const cr = canvas.getBoundingClientRect();
  const lr = layer.getBoundingClientRect();
  if (!cr.width || !lr.width) return 0;
  const sx = canvas.width / cr.width;
  const sy = canvas.height / cr.height;
  // The word spans, in order, grouped into lines.
  const spans = [...layer.querySelectorAll<HTMLElement>("span")].filter((s) => !s.children.length && (s.textContent ?? "").trim());
  const lines: { el: HTMLElement; r: DOMRect }[][] = [];
  for (const el of spans) {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    const line = lines[lines.length - 1];
    const prev = line?.[line.length - 1];
    if (prev && Math.abs(prev.r.top - r.top) < prev.r.height * 0.5 && r.left >= prev.r.left) line!.push({ el, r });
    else lines.push([{ el, r }]);
  }
  let aligned = 0;
  for (const line of lines) {
    const top = Math.min(...line.map((x) => x.r.top));
    const bottom = Math.max(...line.map((x) => x.r.bottom));
    const h = bottom - top;
    const left = line[0]!.r.left;
    const right = Math.max(...line.map((x) => x.r.right));
    // A band through the line's letters (not its neighbours'), wide enough to find the printed
    // line even where the text is a good deal shorter or longer.
    const x0 = Math.max(cr.left, left - 4 * h);
    const x1 = Math.min(cr.right, right + 6 * h);
    const y0 = top + h * 0.2;
    const y1 = bottom - h * 0.15;
    const px = Math.round((x0 - cr.left) * sx);
    const py = Math.round((y0 - cr.top) * sy);
    const pw = Math.round((x1 - x0) * sx);
    const ph = Math.max(1, Math.round((y1 - y0) * sy));
    if (pw <= 0) continue;
    let data: Uint8ClampedArray;
    try {
      data = ctx.getImageData(px, py, pw, ph).data;
    } catch {
      return aligned;
    }
    const runs = inkRuns(data, pw, ph, Math.max(2, Math.round(h * 0.2 * sx)));
    const ink = lineInk(runs, (left - x0) * sx, (right - x0) * sx, 2 * h * sx, 5 * h * sx);
    const placed = placeOnInk(line.map((x) => ({ left: (x.r.left - x0) * sx, width: x.r.width * sx })), ink);
    if (!placed) continue;
    line.forEach((x, i) => {
      const to = placed[i]!;
      const leftPx = x0 + to.left / sx - lr.left;
      const widthPx = to.width / sx;
      x.el.style.left = `${(leftPx / lr.width) * 100}%`;
      const scale = Number.parseFloat(x.el.style.getPropertyValue("--scale-x")) || 1;
      if (x.r.width > 0 && widthPx > 0) x.el.style.setProperty("--scale-x", String((scale * widthPx) / x.r.width));
    });
    aligned++;
  }
  return aligned;
}

const invisible = new WeakMap<object, Promise<boolean>>();
/** Whether a page's text is drawn invisibly (render mode 3 or 7): recognised text over a scan. */
export function invisibleText(page: pdfjs.PDFPageProxy): Promise<boolean> {
  let p = invisible.get(page);
  if (!p) {
    p = page.getOperatorList().then(
      (ops) => ops.fnArray.some((f, i) => f === pdfjs.OPS.setTextRenderingMode && [3, 7].includes(Number((ops.argsArray[i] as unknown[] | undefined)?.[0]))),
      () => false,
    );
    invisible.set(page, p);
  }
  return p;
}
