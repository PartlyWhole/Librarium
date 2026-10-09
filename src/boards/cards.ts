/**
 * What shows inside a board's cards, and a board shown in a note. A capture's card holds its
 * quotation, citation and Show in the source; any other record's card its icon and name. Both
 * are drawn again when the record changes.
 */
import { call } from "../backend";
import { getRecord, isArchived, kindName, openRecord, recordIcon } from "../app/records";
import { h, replace } from "../ui/dom";
import { icon, iconButton } from "../ui/icon";
import { effect, untracked } from "../ui/signal";
import type { RecordInfo } from "../types";
import { appTheme, citation, loadEngine, portable } from "./shared";
import { LocateFixed } from "lucide";

interface Anchor {
  snapshot?: string | null;
  parts?: { selector: unknown[]; boxes?: unknown[] }[];
}

/** Where a capture's source opens: its first part's place, in the snapshot it came from. */
function whereOf(a: Anchor | null): Record<string, string> {
  const part = a?.parts?.[0];
  const place = part ? JSON.stringify([...part.selector, ...(part.boxes?.length ? [{ type: "librarium:boxes", boxes: part.boxes }] : [])]) : "";
  return { ...(place ? { place } : {}), ...(a?.snapshot ? { snapshot: a.snapshot } : {}) };
}

/** Opens a capture's source at its place. */
export function showInSource(r: RecordInfo, newTab = false): void {
  const src = String(r.fields["captures.source"] ?? "");
  void call<Anchor>("captures.anchor", { id: r.id }).then((a) => openRecord(src, whereOf(a), { again: true, newTab }), () => openRecord(src, {}, { newTab }));
}

function captureCard(r: RecordInfo): HTMLElement {
  const quote = String(r.fields["captures.quote"] ?? "").trim();
  return h("div", { class: "board-card-capture" },
    quote ? h("blockquote", { class: "embed-quote" }, quote) : h("p", { class: "muted" }, "A captured region"),
    h("div", { class: "board-card-cite" },
      h("a", { href: "#", class: "embed-cite", onclick: (e: MouseEvent) => (e.preventDefault(), openRecord(r.id, {}, { newTab: e.metaKey })) }, `— ${citation(r)}`),
      iconButton(LocateFixed, "Show in the source", (e) => showInSource(r, e.metaKey), undefined, 14)));
}

function recordCard(r: RecordInfo): HTMLElement {
  return h("a", { href: "#", class: "board-card-link", onclick: (e: MouseEvent) => (e.preventDefault(), openRecord(r.id, {}, { newTab: e.metaKey })) },
    icon(recordIcon(r), 16), h("span", null, r.title || "Untitled"), h("span", { class: "muted small" }, kindName(r)));
}

/** Draws a record's card into `host`, again whenever the record changes; returns how to stop. */
export function renderCard(id: string, host: HTMLElement): () => void {
  let shown: string | null = null;
  return effect(() => {
    const r = getRecord(id);
    const v = r ? `${r.version}${r.title}${isArchived(r)}` : "";
    if (v === shown) return;
    shown = v;
    untracked(() => {
      if (!r) return replace(host, h("div", { class: "board-card missing" }, "This was deleted or can’t be found."));
      replace(host, h("div", { class: `board-card kind-${r.kind}`, role: "group", "aria-label": `${kindName(r)}: ${r.title || "Untitled"}` },
        r.kind === "capture" ? captureCard(r) : recordCard(r),
        isArchived(r) ? h("p", { class: "muted small" }, "In the archive.") : null));
    });
  });
}

/** A board's picture, in the app's look, from its saved drawing. */
export async function boardPicture(id: string): Promise<SVGSVGElement> {
  const [engine, b] = await Promise.all([loadEngine(), call<{ scene: string }>("boards.load", { id })]);
  return engine.boardSvg(b.scene, portable, appTheme() === "dark");
}

/** A board shown in a note: its picture, captioned "— Title"; a click opens it. */
export function boardEmbed(r: RecordInfo, open: (id: string, e: MouseEvent) => void): HTMLElement {
  const title = r.title || "Untitled board";
  const picture = h("div", { class: "embed-board-picture", role: "img", "aria-label": `The board “${title}”` }, h("span", { class: "muted small" }, "Drawing the board…"));
  const go = (e: MouseEvent) => (e.preventDefault(), open(r.id, e));
  void boardPicture(r.id).then((svg) => {
    svg.removeAttribute("width");
    svg.removeAttribute("height");
    replace(picture, svg);
  }, () => replace(picture, h("span", { class: "muted small" }, "This board can’t be drawn here.")));
  return h("figure", { class: "embed embed-board" },
    h("a", { href: "#", class: "embed-board-link", onclick: go, title: "Open the board" }, picture),
    h("figcaption", null, h("a", { href: "#", class: "embed-cite", onclick: go }, `— ${title}`)));
}
