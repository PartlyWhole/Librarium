/**
 * A board's readable page (decision 0062): what is on the drawing, as Markdown, so search,
 * backlinks and other programs see it. Written by the app on every save, never read back.
 * Phase 2 writes the texts; links and captures come with phase 3.
 */
import type { BoardElement } from "./engine";

/** The page's first line, as the boards crate writes it (`page_note`). */
export const pageNote = (id: string) => `<!-- Librarium writes this page from the board's drawing (${id}.excalidraw); edits here are replaced when the board is saved. -->`;

/** How far apart (in drawing units) two texts must be to be on different rows when read. */
const ROW = 24;

/** The page for a drawing: its texts in reading order (rows top to bottom, each left to right). */
export function boardPage(id: string, elements: readonly BoardElement[]): string {
  const texts = elements
    .filter((e) => !e.isDeleted && e.type === "text" && e.text?.trim())
    .sort((a, b) => Math.round(a.y / ROW) - Math.round(b.y / ROW) || a.x - b.x)
    .map((e) => e.text!.trim());
  return `${[pageNote(id), ...texts].join("\n\n")}\n`;
}
