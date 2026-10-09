/**
 * How a board keeps links to records, without React: the page, its readable text and notes
 * use these without loading Excalidraw.
 */

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
  link?: string | null;
  isDeleted?: boolean;
  containerId?: string | null;
  /** `embed`: a card or picture written `![[…]]` (a capture's quotation, a picture). */
  customData?: { librarium?: { links?: BoardLink[]; embed?: boolean } } & Record<string, unknown>;
}

/** An element's link to a record (Excalidraw keeps one link per element). */
export const RECORD_LINK = "librarium://record/";
export const recordOf = (link: string | null | undefined) => (link?.startsWith(RECORD_LINK) ? link.slice(RECORD_LINK.length) : null);

/** Pictures and cards are kept by record ID (a UUID), not as data in the drawing. */
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
