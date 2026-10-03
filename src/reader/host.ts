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
  destroy(): void;
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
