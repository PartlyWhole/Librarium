/**
 * A board's readable page: what is on the drawing, as Markdown, so search, backlinks and other
 * programs see it. Written on every save and never read back.
 *
 * Each text is a paragraph, in reading order (rows top to bottom, each left to right). Links
 * are written `[[label|id]]` with the records' names now, so a rename shows at the next save:
 * - a text's own links where their names are in it, else after it;
 * - a text linked as a whole, or the words of a linked shape, around those words;
 * - a linked shape without words, a card or a picture, on a line of its own (`![[…]]` when it
 *   is an embed).
 */
import { formatLink } from "../notes/editor/links";
import { recordOf, type BoardElement, type BoardLink } from "./links";

/** The page's first line, as the backend writes it for a new board. */
export const pageNote = (id: string) => `<!-- Librarium writes this page from the board's drawing (${id}.excalidraw); edits here are replaced when the board is saved. -->`;

/** How far apart (in drawing units) two things must be to be on different rows. */
const ROW = 24;

const linksOf = (e: BoardElement): BoardLink[] => e.customData?.librarium?.links ?? [];

/** A text's words with each of its links written in. */
function linkedText(words: string, links: BoardLink[], label: (l: BoardLink) => string): string {
  let text = words;
  let from = 0;
  for (const l of links) {
    const at = text.indexOf(l.label, from);
    const link = formatLink(label(l), l.id);
    if (at >= 0) {
      text = text.slice(0, at) + link + text.slice(at + l.label.length);
      from = at + link.length;
    } else text = `${text} ${link}`;
  }
  return text;
}

/** The page for a drawing. `titleOf` gives a record's name now (else the name kept with the link). */
export function boardPage(id: string, elements: readonly BoardElement[], titleOf: (id: string) => string | null = () => null): string {
  const live = elements.filter((e) => !e.isDeleted);
  const byId = new Map(live.map((e) => [e.id, e]));
  const bound = new Set(live.filter((e) => e.type === "text" && e.containerId).map((e) => e.containerId!));
  const label = (l: BoardLink) => titleOf(l.id) ?? l.label;
  const paragraphs: { x: number; y: number; text: string }[] = [];
  for (const e of live) {
    if (e.type === "text") {
      const words = e.text?.trim();
      if (!words) continue;
      const own = linksOf(e);
      let text = words;
      if (own.length) text = linkedText(words, own, label);
      else {
        const target = recordOf(e.link) ?? (e.containerId ? recordOf(byId.get(e.containerId)?.link) : null);
        if (target) text = formatLink(text, target);
      }
      paragraphs.push({ x: e.x, y: e.y, text });
    } else if (!bound.has(e.id)) {
      const target = recordOf(e.link);
      if (!target) continue;
      const kept = linksOf(e).find((l) => l.id === target);
      paragraphs.push({ x: e.x, y: e.y, text: formatLink(titleOf(target) ?? kept?.label ?? "Linked", target, !!e.customData?.librarium?.embed) });
    }
  }
  paragraphs.sort((a, b) => Math.round(a.y / ROW) - Math.round(b.y / ROW) || a.x - b.x);
  return `${[pageNote(id), ...paragraphs.map((p) => p.text)].join("\n\n")}\n`;
}

/**
 * What is on a board as words to read aloud (VoiceOver can't read a canvas): its texts, and
 * its links, cards and pictures by name, in reading order.
 */
export function boardOutline(elements: readonly BoardElement[], titleOf: (id: string) => string | null = () => null): string[] {
  return boardPage("", elements, titleOf)
    .split("\n\n")
    .slice(1)
    .map((p) => p.trim().replace(/!?\[\[((?:\\.|[^\]|])*)\|[^\]]*\]\]/g, (_m, label: string) => label.replace(/\\(.)/g, "$1")))
    .filter(Boolean);
}
