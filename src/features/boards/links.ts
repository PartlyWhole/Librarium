/**
 * How boards keep links to records (no React here: the page and its readable text use this
 * without loading Excalidraw).
 */

/** A link to a record, as kept on a drawing element (its `customData.librarium.links`). */
export interface BoardLink {
  id: string;
  label: string;
}

/** A drawing element as the page and its readable text need it. */
export interface BoardElement {
  id: string;
  type: string;
  x: number;
  y: number;
  text?: string;
  link?: string | null;
  isDeleted?: boolean;
  containerId?: string | null;
  /** Links kept on the element; `embed`: a card or picture written `![[…]]` (a capture's quotation, a picture). */
  customData?: { librarium?: { links?: BoardLink[]; embed?: boolean } } & Record<string, unknown>;
}

/** An element's link to a record (Excalidraw keeps one link per element). */
export const RECORD_LINK = "librarium://record/";
export const recordOf = (link: string | null | undefined) => (link?.startsWith(RECORD_LINK) ? link.slice(RECORD_LINK.length) : null);
