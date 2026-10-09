/**
 * Footnotes, as Apple Books shows them: a note's number opens the note in a popover by it.
 * Chapter-end notes, separate notes files and notes marked by an empty anchor all work; a link
 * that isn't a note (or a note over 3000 words) goes to its place instead.
 */
import { h } from "../../ui/dom";

/** Whether a link is a note's number: marked as one, or a short mark (1, [2], *, †, a). */
export function isNoteRef(a: HTMLAnchorElement): boolean {
  const kind = `${a.getAttributeNS("http://www.idpf.org/2007/ops", "type") ?? a.getAttribute("epub:type") ?? ""} ${a.getAttribute("role") ?? ""}`;
  if (/\bnoteref\b|doc-noteref|doc-backlink|\bbacklink\b/.test(kind)) return /noteref/.test(kind);
  return /^[[(]?(\d{1,4}|[*†‡§¶]{1,3}|[a-z])[\])]?\.?$/i.test((a.textContent ?? "").trim());
}

/**
 * The note an anchor points at, given the element it targets: that element if it holds words,
 * else (an empty anchor, `<a id="n1"/>`) the paragraph it begins. Null when it isn't a note:
 * nothing there, the reference itself, or a whole section.
 */
export function noteAt(target: Element | null, from: HTMLAnchorElement): Element | null {
  if (!target) return null;
  const note = (target.textContent ?? "").trim().length > 4 ? target : (target.closest("p, li, aside, div, section, dd, blockquote") ?? target.parentElement);
  const words = (note?.textContent ?? "").trim();
  if (!note || !words || note.contains(from) || words.length > 3000) return null;
  return note;
}

const KEEP: Record<string, string> = { em: "em", i: "em", strong: "strong", b: "strong", sup: "sup", sub: "sub", br: "br", code: "code", small: "small" };
const BLOCK = new Set(["p", "li", "div", "aside", "section", "blockquote", "dd", "dt"]);
/** A link back to the reference (↵, ↩, "Back", its number). */
const BACKLINK = /^(↵|↩|⤴|\^|back|return|[[(]?(\d{1,4}|[*†‡§¶]{1,3})[\])]?\.?)$/i;

/** The note as plain formatting only, its links back to the text left out. */
function noteBody(note: Element): HTMLElement {
  const out = h("div", { class: "epub-note-body" });
  const walk = (from: Node, into: HTMLElement) => {
    for (const n of from.childNodes) {
      if (n.nodeType === Node.TEXT_NODE) into.append(n.textContent ?? "");
      if (n.nodeType !== Node.ELEMENT_NODE) continue;
      const el = n as Element;
      const tag = el.localName.toLowerCase();
      if (tag === "script" || tag === "style") continue;
      if (tag === "a") {
        if (BACKLINK.test((el.textContent ?? "").trim()) && (el.getAttribute("href") ?? "").includes("#")) continue;
        walk(el, into);
      } else if (KEEP[tag]) walk(el, into.appendChild(document.createElement(KEEP[tag]!)));
      else if (BLOCK.has(tag)) walk(el, into.appendChild(h("p")));
      else walk(el, into);
    }
  };
  walk(note, BLOCK.has(note.localName.toLowerCase()) ? out.appendChild(h("p")) : out);
  for (const p of [...out.querySelectorAll("p")]) if (!p.textContent?.trim() && !p.querySelector("br")) p.remove();
  // What the left-out number leaves at the start (". The note…").
  const walker = document.createTreeWalker(out, NodeFilter.SHOW_TEXT);
  for (let t = walker.nextNode(); t; t = walker.nextNode()) {
    const v = (t.textContent ?? "").replace(/^[\s.:)\]–—-]+/, "");
    t.textContent = v;
    if (v) break;
  }
  return out;
}

/**
 * The note's popover, placed below its number (window rect `at`), or above it when there isn't
 * room, in the book's colours. Escape and Close call `close`; Go to note calls `go`.
 */
export function notePopover(note: Element, at: DOMRect, colours: { bg: string; text: string }, close: () => void, go: () => void): HTMLElement {
  const goBtn = h("button", { type: "button", class: "link-button small", onclick: () => (close(), go()) }, "Go to note");
  const el = h("div", { class: "epub-popover epub-note", role: "dialog", "aria-label": "Note" },
    noteBody(note),
    h("div", { class: "epub-note-foot" }, goBtn, h("button", { type: "button", class: "link-button small", onclick: close }, "Close")));
  el.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    e.stopPropagation();
    close();
  });
  el.style.background = colours.bg;
  el.style.color = colours.text;
  document.body.appendChild(el);
  const w = el.offsetWidth;
  const hgt = el.offsetHeight;
  el.style.left = `${Math.round(Math.min(Math.max(8, at.left - 24), window.innerWidth - w - 8))}px`;
  el.style.top = `${Math.round(at.bottom + 8 + hgt > window.innerHeight - 8 ? Math.max(8, at.top - hgt - 8) : at.bottom + 8)}px`;
  setTimeout(() => goBtn.focus(), 0);
  return el;
}
