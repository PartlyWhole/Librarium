/**
 * Makes a book’s pages safe to show.
 *
 * Book pages are shown in frames that run scripts: the reader's own (Readium's, loaded from
 * blob URLs) need them, and WebKit runs no event listeners at all in a frame without
 * `allow-scripts` (https://bugs.webkit.org/show_bug.cgi?id=218086). The book's own code is
 * made inert here, before a page is shown:
 * - script elements are emptied and given a type no browser runs (kept in place, so EPUB CFI
 *   paths to the text after them don't change);
 * - frames, plugins and portals lose what they would load; `<base>` and `<meta http-equiv>`
 *   are removed;
 * - `on…` handlers and `javascript:` (and similar) links are removed;
 * - each page gets a Content Security Policy allowing scripts only from blob URLs (the
 *   reader's), with no plugins, frames, workers or form submission.
 * The book's script files are never served (streamer.ts), so no blob URL holds book code.
 */

/** The policy given to every page of a book. */
export const BOOK_CSP = "script-src blob:; object-src 'none'; frame-src 'none'; child-src 'none'; worker-src 'none'; form-action 'none'";

const MARKUP = new Set(["application/xhtml+xml", "text/html", "image/svg+xml"]);

/** Whether a book resource of this type is markup to clean. */
export function isMarkup(type: string): boolean {
  return MARKUP.has(type.split(";")[0]!.trim().toLowerCase());
}

const LOADERS = "iframe, frame, object, embed, applet, portal";
const LOADER_ATTRS = ["src", "srcdoc", "data", "code", "codebase", "archive"];
const URL_ATTRS = new Set(["href", "src", "action", "formaction", "data", "xlink:href", "poster", "background"]);
const SCRIPTED_URL = /^(javascript|vbscript|data:text\/html|data:application\/xhtml)/i;

/** Makes everything in a parsed page that could run inert, in place. */
export function neutralize(doc: Document): void {
  for (const s of [...doc.querySelectorAll("script")]) {
    s.textContent = "";
    for (const a of [...s.attributes]) s.removeAttributeNode(a);
    s.setAttribute("type", "application/x-librarium-inert");
  }
  for (const el of [...doc.querySelectorAll(LOADERS)]) for (const a of LOADER_ATTRS) el.removeAttribute(a);
  for (const el of [...doc.querySelectorAll("base, meta[http-equiv]")]) el.remove();
  for (const el of [...doc.querySelectorAll("*")]) {
    for (const a of [...el.attributes]) {
      const name = a.name.toLowerCase();
      if (name.startsWith("on")) el.removeAttributeNode(a);
      else if (URL_ATTRS.has(name) && SCRIPTED_URL.test([...a.value].filter((c) => c > " ").join(""))) el.removeAttributeNode(a);
    }
  }
}

/** Adds the book policy (and any other meta) first in a page's head, if it has one. */
export function addMeta(doc: Document, attrs: Record<string, string>): void {
  const head = doc.documentElement.namespaceURI === "http://www.w3.org/2000/svg" ? null : doc.querySelector("head");
  if (!head) return;
  const meta = doc.createElementNS(doc.documentElement.namespaceURI ?? "http://www.w3.org/1999/xhtml", "meta");
  for (const [k, v] of Object.entries(attrs)) meta.setAttribute(k, v);
  head.prepend(meta);
}

/** Parses a book page, falling back to HTML for broken XHTML (as readers do). */
export function parsePage(text: string, type: string): Document {
  const mime = type.split(";")[0]!.trim().toLowerCase();
  const doc = new DOMParser().parseFromString(text, mime as DOMParserSupportedType);
  if (mime !== "text/html" && doc.querySelector("parsererror")) return new DOMParser().parseFromString(text, "text/html");
  return doc;
}

/** A book page with its code made inert and the book policy in its head (as XML). */
export function safeMarkup(text: string, type: string): string {
  const doc = parsePage(text, type);
  neutralize(doc);
  addMeta(doc, { "http-equiv": "Content-Security-Policy", content: BOOK_CSP });
  return new XMLSerializer().serializeToString(doc);
}
