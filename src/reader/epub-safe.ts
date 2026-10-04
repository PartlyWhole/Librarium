/**
 * Makes a book's pages safe to show in frames that allow scripts (decision 0043).
 *
 * WebKit runs no event listeners at all, not even the app's, in a frame sandboxed without
 * `allow-scripts` (https://bugs.webkit.org/show_bug.cgi?id=218086). Reading needs those
 * listeners (selection, keys, the wheel), so book frames allow scripts, and the book's own
 * scripts are stopped here instead, twice over:
 * - everything that could run code is removed: scripts, frames, plugins, `on…` handlers,
 *   `javascript:` links, refresh redirects, `<base>`;
 * - each page gets a Content Security Policy that forbids scripts, plugins, frames and
 *   workers, in case anything was missed.
 * Script files in the book are never loaded (see epub.ts).
 */

/** The policy given to every page of a book. */
export const BOOK_CSP = "script-src 'none'; object-src 'none'; frame-src 'none'; child-src 'none'; worker-src 'none'; base-uri 'none'; form-action 'none'";

const MARKUP = new Set(["application/xhtml+xml", "text/html", "image/svg+xml"]);

/** Whether a book resource of this type is markup to clean. */
export function isMarkup(type: string): boolean {
  return MARKUP.has(type.split(";")[0]!.trim().toLowerCase());
}

const DANGEROUS = "script, iframe, frame, frameset, object, embed, applet, portal, base, meta[http-equiv]";
const URL_ATTRS = ["href", "src", "action", "formaction", "data", "xlink:href"];

/** A book page with nothing left that could run, and the book policy in its head. */
export function safeMarkup(text: string, type: string): string {
  const mime = type.split(";")[0]!.trim().toLowerCase();
  const doc = new DOMParser().parseFromString(text, mime as DOMParserSupportedType);
  if (doc.querySelector("parsererror")) {
    // Foliate falls back to HTML for broken XHTML; clean it the same way.
    return mime === "text/html" ? "" : safeMarkup(text, "text/html");
  }
  for (const el of [...doc.querySelectorAll(DANGEROUS)]) el.remove();
  for (const el of [...doc.querySelectorAll("*")]) {
    for (const a of [...el.attributes]) {
      const name = a.name.toLowerCase();
      if (name.startsWith("on")) el.removeAttributeNode(a);
      else if (URL_ATTRS.includes(name) && /^\s*(javascript|vbscript|data:text\/html)/i.test([...a.value].filter((c) => c > " ").join(""))) el.removeAttributeNode(a);
    }
  }
  // SVG has no <meta>; it has had everything that runs removed above.
  const head = mime === "image/svg+xml" ? null : doc.head ?? doc.querySelector("head");
  if (head) {
    const ns = doc.documentElement.namespaceURI ?? "http://www.w3.org/1999/xhtml";
    const meta = doc.createElementNS(ns, "meta");
    meta.setAttribute("http-equiv", "Content-Security-Policy");
    meta.setAttribute("content", BOOK_CSP);
    head.prepend(meta);
  }
  return mime === "text/html" ? `<!DOCTYPE html>${doc.documentElement.outerHTML}` : new XMLSerializer().serializeToString(doc);
}
