/**
 * A capture placed in a note (`![[label|id]]`): its quotation with "— Source, place", and its
 * title above when `{title}` follows the embed. With several parts, "[…]" stands between them
 * (a space where one runs on) and pictures show on their own. A click on the quotation opens
 * the capture, the citation opens the source at the place; on hover, the pencil opens the
 * capture and the title button shows or hides the title. ⌘ opens in a new tab. On export it
 * becomes a Markdown quotation.
 */
import { h } from "../ui/dom";
import { icon } from "../ui/icon";
import type { RecordInfo } from "../types";
import { anchorOf, citation, drawnCapture, F, isRegion, partQuote, partsAsQuoted, quoteOf, quoteParts, regionImage, showInSource, type ShownPart } from "./common";
import { flowQuote } from "./anchor";
import { Heading, Pencil } from "lucide";
import "./captures.css";

/** `titled`: the title shows above the quotation; `toggleTitle` shows or hides it. */
export function captureEmbed(r: RecordInfo, open: (id: string, e: MouseEvent) => void, o: { titled?: boolean; toggleTitle?: () => void } = {}): HTMLElement {
  const quote = quoteOf(r);
  const cite = h("a", { href: "#", class: "embed-cite", title: "Show it in the source", onclick: (e: MouseEvent) => (e.preventDefault(), showInSource(r, { newTab: e.metaKey })) }, `— ${citation(r)}`);
  const edit = h("button", { type: "button", class: "embed-edit icon-button", "aria-label": "Edit the capture", title: "Open the capture to edit it", onclick: (e: MouseEvent) => (e.preventDefault(), open(r.id, e)) }, icon(Pencil, 14));
  const titleButton = o.toggleTitle
    ? h("button", { type: "button", class: "embed-edit icon-button", "aria-pressed": String(!!o.titled), "aria-label": o.titled ? "Hide the title" : "Show the title", title: o.titled ? "Hide the title" : "Show the title above the quotation", onclick: (e: MouseEvent) => (e.preventDefault(), e.stopPropagation(), o.toggleTitle!()) }, icon(Heading, 14))
    : null;
  const heading = o.titled ? h("div", { class: "embed-capture-title" }, r.title || "Capture") : null;
  const block = h("figure", { class: "embed embed-capture", title: "Open the capture" }, heading, quote ? h("blockquote", { class: "embed-quote" }, quote) : null, h("figcaption", null, cite, titleButton, edit));
  block.addEventListener("click", (e) => {
    if ((e.target as Element).closest("a, button")) return;
    e.preventDefault();
    open(r.id, e);
  });
  // From the app's own data (a word's entry): drawn as its source shows it.
  void drawnCapture(r).then((el) => {
    if (!el) return;
    block.querySelectorAll(":scope > .embed-quote").forEach((x) => x.remove());
    block.querySelector(":scope > figcaption")!.before(el);
  });
  // Several parts, or a picture: each part in order, pictures as pictures.
  if (Number(r.fields[F.parts] ?? 1) > 1 || !quote) {
    void anchorOf(r.id).then((a) => {
      const quoted = partsAsQuoted(quote, a.parts.map((p) => ({ text: isRegion(p) ? null : flowQuote(partQuote(p)), continues: p.continues })));
      const parts = a.parts.map((p, i): ShownPart => (isRegion(p) ? { picture: regionImage(r.id, i + 1, "capture-region embed-region") } : { text: quoted[i] ?? "", joined: !!p.continues }));
      block.querySelector(":scope > .embed-quote")?.remove();
      block.querySelector(":scope > figcaption")!.before(...quoteParts(parts, "embed-quote"));
    }, () => {});
  }
  return block;
}

/** A capture as Markdown: `> quote` lines and `> — Source, place`, with its title in bold
 * above when it is shown. */
export function captureMarkdown(r: RecordInfo, titled = false): string {
  const quote = quoteOf(r) || "[a captured region]";
  return `${titled ? `**${r.title || "Capture"}**\n\n` : ""}${quote.split("\n").map((l) => (l ? `> ${l}` : ">")).join("\n")}\n>\n> — ${citation(r)}`;
}
