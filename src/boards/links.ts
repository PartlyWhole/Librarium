/**
 * How a board keeps links to records, without React: the page, its readable text and notes
 * use these without loading Excalidraw.
 */

import { parseLinks } from "../notes/editor/links";

/** A link to a record, as kept on a drawing element (`customData.librarium.links`). */
export interface BoardLink {
  id: string;
  label: string;
}

/** A drawing element, as much as the page and its readable text need. */
export interface BoardElement {
  id: string;
  type: string;
  x: number;
  y: number;
  text?: string;
  /** A text's words as written (`text` is as wrapped in its shape). */
  originalText?: string;
  link?: string | null;
  isDeleted?: boolean;
  containerId?: string | null;
  /** `embed`: a card or picture written `![[…]]` (a capture's quotation, a picture). */
  customData?: { librarium?: { links?: BoardLink[]; embed?: boolean; text?: string } } & Record<string, unknown>;
}

/** A text box: an `embeddable` with this link, its Markdown in `customData.librarium.text`. */
export const TEXT_BOX = "librarium://text";
export const isTextBox = (e: { type: string; link?: string | null }) => e.type === "embeddable" && e.link === TEXT_BOX;
export const boxText = (e: { customData?: unknown }): string => (e.customData as BoardElement["customData"])?.librarium?.text ?? "";

/** An element's link to a record (Excalidraw keeps one link per element). */
export const RECORD_LINK = "librarium://record/";
export const recordOf = (link: string | null | undefined) => (link?.startsWith(RECORD_LINK) ? link.slice(RECORD_LINK.length) : null);

/** Pictures and cards are kept by record ID (a UUID), not as data in the drawing. */
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Whether text has a link or embed to a record in it (`[[label|id]]`, `![[label|id]]`). */
export const hasRefs = (text: string): boolean => parseLinks(text).some((l) => l.id);

/**
 * Text as it reads, each link and embed written as its name (an embed's `{width=…}` or
 * `{title}` left out), with the links to records in it, each record once.
 */
export function wordsAndLinks(text: string): { words: string; links: BoardLink[] } {
  let words = "";
  let last = 0;
  const links: BoardLink[] = [];
  for (const l of parseLinks(text)) {
    words += text.slice(last, l.from) + l.label;
    last = l.to + (/^\{(?:width=\d{1,5}|title)\}/.exec(text.slice(l.to))?.[0].length ?? 0);
    if (l.id && !links.some((x) => x.id === l.id)) links.push({ id: l.id, label: l.label });
  }
  return { words: words + text.slice(last), links };
}
