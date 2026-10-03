/**
 * A selectable layer of recognised text over an image or a scanned page: one transparent span
 * per recognised line, at its place, stretched to its width (as PDF.js does for real text).
 */
export interface OcrLine {
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export function ocrLayer(over: HTMLElement, lines: OcrLine[]): HTMLElement {
  over.querySelector(":scope > .ocr-layer")?.remove();
  const layer = document.createElement("div");
  layer.className = "ocr-layer";
  if (getComputedStyle(over).position === "static") over.style.position = "relative";
  over.appendChild(layer);
  const H = over.clientHeight || 1;
  const W = over.clientWidth || 1;
  for (const l of lines) {
    const s = document.createElement("span");
    s.textContent = l.text;
    Object.assign(s.style, { left: `${l.x * 100}%`, top: `${l.y * 100}%`, fontSize: `${Math.max(4, l.h * H * 0.85)}px`, lineHeight: `${l.h * H}px` });
    layer.appendChild(s);
    layer.appendChild(document.createElement("br"));
    const natural = s.getBoundingClientRect().width;
    if (natural > 0) s.style.transform = `scaleX(${(l.w * W) / natural})`;
  }
  return layer;
}

/** Marks the lines containing `query`; returns how many. */
export function ocrFind(layer: ParentNode, query: string): HTMLElement[] {
  const q = query.trim().toLowerCase();
  const hits: HTMLElement[] = [];
  layer.querySelectorAll<HTMLElement>(".ocr-layer span").forEach((s) => {
    const hit = !!q && (s.textContent ?? "").toLowerCase().includes(q);
    s.classList.toggle("ocr-hit", hit);
    if (hit) hits.push(s);
  });
  return hits;
}
