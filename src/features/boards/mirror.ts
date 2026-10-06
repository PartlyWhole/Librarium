/**
 * A board's readable page (decision 0062): what is on the drawing, as Markdown, so search,
 * backlinks and other programs see it. Written by the app on every save, never read back.
 *
 * Each text is a paragraph, in reading order (rows top to bottom, each left to right). Links are
 * written `[[label|id]]` (BRIEF §5.4), so the kernel's one parser finds them:
 * - a text's links (`customData.librarium.links`) where their names are in it;
 * - a shape linked to a record, around its words (its bound text), or on a line of its own.
 * Labels are the records' names now, so a rename shows here at the next save.
 */
import { formatLink } from "../../editor/links";
import { recordOf, type BoardElement, type BoardLink } from "./links";

/** The page's first line, as the boards crate writes it (`page_note`). */
export const pageNote = (id: string) => `<!-- Librarium writes this page from the board's drawing (${id}.excalidraw); edits here are replaced when the board is saved. -->`;

/** How far apart (in drawing units) two things must be to be on different rows when read. */
const ROW = 24;

const linksOf = (e: BoardElement): BoardLink[] => e.customData?.librarium?.links ?? [];

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
      if (own.length) {
        // Each link where its name is in the text (as typed with [[), in order, else after it.
        let from = 0;
        for (const l of own) {
          const at = text.indexOf(l.label, from);
          const link = formatLink(label(l), l.id);
          if (at >= 0) {
            text = text.slice(0, at) + link + text.slice(at + l.label.length);
            from = at + link.length;
          } else text = `${text} ${link}`;
        }
      } else {
        // A text linked as a whole, or the words of a linked shape.
        const target = recordOf(e.link) ?? (e.containerId ? recordOf(byId.get(e.containerId)?.link) : null);
        if (target) text = formatLink(text, target);
      }
      paragraphs.push({ x: e.x, y: e.y, text });
    } else if (!bound.has(e.id)) {
      // A linked shape with no words of its own: its link, on a line.
      const target = recordOf(e.link);
      if (!target) continue;
      const kept = linksOf(e).find((l) => l.id === target);
      paragraphs.push({ x: e.x, y: e.y, text: formatLink(titleOf(target) ?? kept?.label ?? "Linked", target) });
    }
  }
  paragraphs.sort((a, b) => Math.round(a.y / ROW) - Math.round(b.y / ROW) || a.x - b.x);
  return `${[pageNote(id), ...paragraphs.map((p) => p.text)].join("\n\n")}\n`;
}
