/**
 * What every reader engine (PDF, image, EPUB) offers the item page and the captures feature,
 * and the selectors that name a place in a document.
 */

/** What an engine is given to open. */
interface ReaderSource {
  id: string;
  title: string;
  /** The file's bytes (the original, or a saved page's snapshot PDF). */
  bytes(): Promise<ArrayBuffer>;
  /** The stored extracted text (`extracted/text-v1.json`), if any. */
  text(): Promise<Extracted | null>;
  /** The text anchors see (`records.text`), whose words correct what PDF.js misreads. */
  storedText(): Promise<string | null>;
}

/** The extracted text as stored (FORMAT.md › Stored text). */
export interface Extracted {
  extractor: string;
  version: number;
  pages?: { page: number; text: string; lines?: { text: string; x: number; y: number; w: number; h: number }[] }[];
  chapters?: { href: string; path?: string; title?: string | null; text: string }[];
}

interface ReaderEvents {
  /** The position changed (a page turned, a scroll). */
  moved(): void;
  /** The first page is on screen (for the 500 ms budget). */
  firstPaint(ms: number): void;
}

export type Engine = (host: HTMLElement, src: ReaderSource, events: ReaderEvents) => Promise<ReaderView>;

export type Layout = "single" | "two" | "scroll";

interface FindResult {
  count: number;
  current: number;
}

export interface ReaderView {
  zoomIn(): void;
  zoomOut(): void;
  zoomReset(): void;
  /** How a book's pages are laid out (books that can be restyled). */
  layout?: { get(): Layout; set(layout: Layout): void };
  /** Finds `query`; `again` moves to the next (with `back`, the previous) match. */
  find(query: string, opts?: { again?: boolean; back?: boolean }): Promise<FindResult>;
  findClear(): void;
  /** Shows the place `offset` code points into the stored text (a search hit). */
  goToTextOffset?(offset: number): void;
  /** A short position for the toolbar ("Page 3 of 100"). */
  position(): string;
  /** The user's text selection, with where it is. */
  selection?(): ReaderSelection | null;
  /** Calls `cb` whenever the user finishes making (or clears) a selection. */
  watchSelection?(cb: () => void): () => void;
  clearSelection?(): void;
  /** Lets the user drag out a region; resolves with it, or null if cancelled. */
  pickRegion?(): Promise<ReaderRegion | null>;
  /** Draws these marks (saved captures, a capture being made), replacing earlier ones. */
  setMarks?(marks: Mark[]): void;
  /** Calls `cb` with the saved marks under a plain click (not the end of a selection). */
  onMarkClick?(cb: (ids: string[], at: { x: number; y: number }) => void): () => void;
  /** Goes to a place given by W3C selectors (page, quote, region, CFI); centres and shows it. */
  showPlace?(selectors: PlaceSelector[]): Promise<boolean>;
  /**
   * Edits a capture's parts in place: text parts get handles at their ends, regions a frame to
   * move and resize. `onChange` reports each part while dragged (`done` false) and when let go
   * (`done` true, with what to store).
   */
  editParts?(parts: EditPart[], onChange: (p: EditedPart) => void): PartsEditor;
  /** Reading without chrome (books): the toolbar shows only when wanted. */
  immersive?: boolean;
  /** The engine's own toolbar controls: `start` go first, `end` before find. */
  controls?: { start?: HTMLElement[]; end?: HTMLElement[] };
  /** The pointer's place (window coordinates) as it moves over the document. */
  onPointer?(cb: (at: { x: number; y: number }) => void): () => void;
  /** Whether the engine wants the toolbar kept showing (one of its popovers is open). */
  onChromeWanted?(cb: (wanted: boolean) => void): () => void;
  destroy(): void;
}

/** A part of a capture being edited, as the reader finds it. */
export interface EditPart {
  key: string;
  /** A region (percent of its page, or of the image). */
  region?: { page?: number; x: number; y: number; w: number; h: number };
  /** A text part: where it was drawn (PDF, image), its CFI (EPUB), its page and quote. */
  boxes?: Box[];
  cfi?: string | null;
  page?: number;
  quote?: string;
}

/** A part as edited: its new text (with where it is), or its new region (with its picture). */
export interface EditedPart {
  key: string;
  done: boolean;
  text?: ReaderSelection;
  region?: ReaderRegion | (Omit<ReaderRegion, "png"> & { png?: undefined });
}

export interface PartsEditor {
  /** The parts changed (one added or removed): edit these. */
  update(parts: EditPart[]): void;
  stop(): void;
}

export interface ReaderSelection {
  text: string;
  /** A picture selected on its own (EPUB), as a PNG data URL. */
  image?: string;
  /** 1-based page (PDF). */
  page?: number;
  /** Spine index (EPUB). */
  chapter?: number;
  /** EPUB CFI. */
  cfi?: string;
  /** Where the text sits: line boxes in percent of their page (or of the image). */
  boxes?: Box[];
  /** The selection's last line on screen (window coordinates), to place controls by it. */
  end?: { x: number; y: number; bottom: number };
}

/** A box in percent of a page (PDF, with its 1-based page) or of an image. */
export interface Box {
  page?: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A highlighted place: text boxes, a region, or (EPUB) a CFI. */
export interface Mark {
  id: string;
  boxes: Box[];
  region?: boolean;
  cfi?: string;
  /** Already saved (drawn softer, and clickable), rather than pending. */
  saved?: boolean;
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
  prefix?: string;
  suffix?: string;
  refinedBy?: PlaceSelector;
  /** With type "librarium:boxes": where the place was drawn (percent of its page). */
  boxes?: Box[];
}

/** The box around a place's drawn boxes on the first page they are on. */
export function boxesPlace(selectors: PlaceSelector[]): { page?: number; region: { x: number; y: number; w: number; h: number } } | null {
  const boxes = selectors.find((s) => s.type === "librarium:boxes")?.boxes;
  if (!boxes?.length) return null;
  const page = boxes[0]!.page;
  const on = boxes.filter((b) => b.page === page);
  const x = Math.min(...on.map((b) => b.x));
  const y = Math.min(...on.map((b) => b.y));
  return { page, region: { x, y, w: Math.max(...on.map((b) => b.x + b.w)) - x, h: Math.max(...on.map((b) => b.y + b.h)) - y } };
}

/** "page=3" (RFC 8118). */
export function pageOf(selectors: PlaceSelector[]): number | null {
  for (const s of selectors) {
    const m = s.type === "FragmentSelector" ? /^page=(\d+)/.exec(s.value ?? "") : null;
    if (m) return Number(m[1]);
  }
  return null;
}

/** "xywh=percent:x,y,w,h", here or in a refinement. */
export function regionOf(selectors: PlaceSelector[]): { x: number; y: number; w: number; h: number } | null {
  for (const s of selectors) {
    for (const v of [s.value, s.refinedBy?.value]) {
      const m = /^xywh=percent:([\d.]+),([\d.]+),([\d.]+),([\d.]+)/.exec(v ?? "");
      if (m) return { x: Number(m[1]), y: Number(m[2]), w: Number(m[3]), h: Number(m[4]) };
    }
  }
  return null;
}

/** Which page (0-based) holds a code-point offset into pages joined by blank lines. */
export function pageAtOffset(pages: { text: string }[], offset: number): number {
  let at = 0;
  for (let i = 0; i < pages.length; i++) {
    const len = [...pages[i]!.text].length + 2;
    if (offset < at + len) return i;
    at += len;
  }
  return Math.max(0, pages.length - 1);
}
