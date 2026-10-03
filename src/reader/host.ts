/**
 * The reader host and its engine registry (slot shell.reader-engines): one engine per format.
 * An engine opens an item into a host element and offers zoom, find and positions.
 */
export interface ReaderSource {
  id: string;
  format: string;
  title: string;
  /** The untouched original's bytes. */
  bytes(): Promise<ArrayBuffer>;
  /** The stored extracted text (JSON), if any. */
  text(): Promise<StoredText | null>;
}

export interface StoredText {
  extractor: string;
  version: number;
  pages?: { page: number; text: string }[];
  chapters?: { href: string; path?: string; title?: string | null; text: string }[];
}

export interface FindResult {
  count: number;
  current: number;
}

export interface ReaderView {
  zoomIn(): void;
  zoomOut(): void;
  zoomReset(): void;
  /** Finds `query`; `again` moves to the next (or, with `back`, the previous) match. */
  find(query: string, opts?: { again?: boolean; back?: boolean }): Promise<FindResult>;
  findClear(): void;
  /** Shows the place `offset` code points into the stored text (from search). */
  goToTextOffset?(offset: number): void;
  /** A short position for the toolbar ("Page 3 of 100"). */
  position(): string;
  /** The user's text selection, with where it is. */
  selection?(): ReaderSelection | null;
  /** Lets the user drag out a region; resolves with it (or null if cancelled). */
  pickRegion?(): Promise<ReaderRegion | null>;
  /** Shows a place given by W3C selectors (page, quote, region, CFI). */
  showPlace?(selectors: PlaceSelector[]): Promise<boolean>;
  destroy(): void;
}

export interface ReaderSelection {
  text: string;
  /** 1-based page (PDF). */
  page?: number;
  /** Spine index (EPUB). */
  chapter?: number;
  /** EPUB CFI. */
  cfi?: string;
}

export interface ReaderRegion {
  /** 1-based page (PDF). */
  page?: number;
  /** Percent of the page or image. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** The region as a PNG data URL. */
  png: string;
}

export interface PlaceSelector {
  type: string;
  value?: string;
  exact?: string;
  refinedBy?: PlaceSelector;
}

/** Parses "page=3" (RFC 8118). */
export function pageOf(selectors: PlaceSelector[]): number | null {
  for (const s of selectors) {
    const m = s.type === "FragmentSelector" ? /^page=(\d+)/.exec(s.value ?? "") : null;
    if (m) return Number(m[1]);
  }
  return null;
}

/** Parses "xywh=percent:x,y,w,h" (here or in a refinement). */
export function regionOf(selectors: PlaceSelector[]): { x: number; y: number; w: number; h: number } | null {
  for (const s of selectors) {
    for (const v of [s.value, s.refinedBy?.value]) {
      const m = /^xywh=percent:([\d.]+),([\d.]+),([\d.]+),([\d.]+)/.exec(v ?? "");
      if (m) return { x: Number(m[1]), y: Number(m[2]), w: Number(m[3]), h: Number(m[4]) };
    }
  }
  return null;
}

/** Lets the user drag a rectangle over `host`; resolves with it in host pixels. */
export function dragRect(host: HTMLElement): Promise<DOMRect | null> {
  return new Promise((resolve) => {
    const layer = document.createElement("div");
    layer.className = "region-layer";
    const box = document.createElement("div");
    box.className = "region-box";
    layer.appendChild(box);
    host.appendChild(layer);
    let start: { x: number; y: number } | null = null;
    const done = (r: DOMRect | null) => {
      layer.remove();
      window.removeEventListener("keydown", onKey, true);
      resolve(r);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        done(null);
      }
    };
    window.addEventListener("keydown", onKey, true);
    layer.addEventListener("mousedown", (e) => {
      const b = layer.getBoundingClientRect();
      start = { x: e.clientX - b.left, y: e.clientY - b.top };
      e.preventDefault();
    });
    layer.addEventListener("mousemove", (e) => {
      if (!start) return;
      const b = layer.getBoundingClientRect();
      const x = e.clientX - b.left;
      const y = e.clientY - b.top;
      Object.assign(box.style, { left: `${Math.min(x, start.x)}px`, top: `${Math.min(y, start.y)}px`, width: `${Math.abs(x - start.x)}px`, height: `${Math.abs(y - start.y)}px`, display: "block" });
    });
    layer.addEventListener("mouseup", () => {
      if (!start) return done(null);
      const r = box.getBoundingClientRect();
      done(r.width > 4 && r.height > 4 ? r : null);
    });
  });
}

/** Crops a region of a canvas or image (in its own pixels) to a PNG data URL. */
export function cropToPng(src: HTMLCanvasElement | HTMLImageElement, sx: number, sy: number, sw: number, sh: number): string {
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(sw));
  c.height = Math.max(1, Math.round(sh));
  c.getContext("2d")!.drawImage(src, sx, sy, sw, sh, 0, 0, c.width, c.height);
  return c.toDataURL("image/png");
}

/** Draws a region outline (percent) over an element. */
export function outlineRegion(over: HTMLElement, r: { x: number; y: number; w: number; h: number }): HTMLElement {
  over.querySelectorAll(".region-mark").forEach((n) => n.remove());
  const mark = document.createElement("div");
  mark.className = "region-mark";
  Object.assign(mark.style, { left: `${r.x}%`, top: `${r.y}%`, width: `${r.w}%`, height: `${r.h}%` });
  if (getComputedStyle(over).position === "static") over.style.position = "relative";
  over.appendChild(mark);
  return mark;
}

export interface ReaderEngine {
  id: string;
  formats: string[];
  open(host: HTMLElement, src: ReaderSource, events: ReaderEvents): Promise<ReaderView>;
}

export interface ReaderEvents {
  /** The position changed (page turned, scrolled). */
  moved(): void;
  /** The first page is on screen (for the 500 ms budget). */
  firstPaint(ms: number): void;
}

/** Which page holds a code-point offset into pages joined by blank lines. */
export function pageAtOffset(pages: { text: string }[], offset: number): number {
  let at = 0;
  for (let i = 0; i < pages.length; i++) {
    const len = [...pages[i]!.text].length + 2;
    if (offset < at + len) return i;
    at += len;
  }
  return Math.max(0, pages.length - 1);
}
