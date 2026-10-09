/**
 * A capture placed in a note (`![[label|id]]`): its quotation with "— Source, place". With
 * several parts, "[…]" stands between them and pictures show on their own. A click on the
 * quotation opens the capture, the citation opens the source at the place, the pencil (on
 * hover) opens the capture; ⌘ opens in a new tab. On export it becomes a Markdown quotation.
 */
import { h } from "../ui/dom";
import { icon } from "../ui/icon";
import type { RecordInfo } from "../types";
import { anchorOf, citation, F, isRegion, partQuote, quoteOf, quoteParts, regionImage, showInSource, type ShownPart } from "./common";
import { flowQuote } from "./anchor";
import { Pencil } from "lucide";
import "./captures.css";

export function captureEmbed(r: RecordInfo, open: (id: string, e: MouseEvent) => void): HTMLElement {
  const quote = quoteOf(r);
  const cite = h("a", { href: "#", class: "embed-cite", title: "Show it in the source", onclick: (e: MouseEvent) => (e.preventDefault(), showInSource(r, { newTab: e.metaKey })) }, `— ${citation(r)}`);
  const edit = h("button", { type: "button", class: "embed-edit icon-button", "aria-label": "Edit the capture", title: "Open the capture to edit it", onclick: (e: MouseEvent) => (e.preventDefault(), open(r.id, e)) }, icon(Pencil, 14));
  const block = h("figure", { class: "embed embed-capture", title: "Open the capture" }, quote ? h("blockquote", { class: "embed-quote" }, quote) : null, h("figcaption", null, cite, edit));
  block.addEventListener("click", (e) => {
    if ((e.target as Element).closest("a, button")) return;
    e.preventDefault();
    open(r.id, e);
  });
  // Several parts, or a picture: each part in order, pictures as pictures.
  if (Number(r.fields[F.parts] ?? 1) > 1 || !quote) {
    void anchorOf(r.id).then((a) => {
      const parts = a.parts.map((p, i): ShownPart => (isRegion(p) ? { picture: regionImage(r.id, i + 1, "capture-region embed-region") } : { text: flowQuote(partQuote(p)) }));
      block.querySelector(":scope > .embed-quote")?.remove();
      block.prepend(...quoteParts(parts, "embed-quote"));
    }, () => {});
  }
  return block;
}

/** A capture as Markdown: `> quote` lines and `> — Source, place`. */
export function captureMarkdown(r: RecordInfo): string {
  const quote = quoteOf(r) || "[a captured region]";
  return `${quote.split("\n").map((l) => (l ? `> ${l}` : ">")).join("\n")}\n>\n> — ${citation(r)}`;
}
