/**
 * The reader: the item page (PDFs, saved web pages, images, books), Find in this item, the
 * View menu's book layouts, and the About this item view of the side panel. Other features
 * work in readers through `onReaderOpen` and `currentReader` (session.ts).
 */
import { defineAction } from "../app/actions";
import { pages } from "../app/pages";
import { addPanelView } from "../app/panel";
import { getRecord } from "../app/records";
import { router } from "../app/router";
import { h, replace } from "../ui/dom";
import { effect } from "../ui/signal";
import { focusFind, renderItem } from "./page";
import { currentReader } from "./session";
import type { Layout } from "./types";
import { BookOpen, Info } from "lucide";
import "./reader.css";

export { currentReader, onReaderOpen, type OpenReader } from "./session";
export type { Box, EditedPart, EditPart, Mark, PartsEditor, PlaceSelector, ReaderRegion, ReaderSelection, ReaderView } from "./types";

pages.item = { title: "Item", icon: BookOpen, render: renderItem };

defineAction({ id: "reader.find", title: "Find in this item", keys: ["Mod+F"], when: () => router.current().page === "item", run: focusFind, menu: { name: "edit", group: 1.9 } });

// A book's layout, as in Apple Books' View menu (also in the Aa panel).
const LAYOUTS: [Layout, string, number][] = [["single", "Single Page", 1], ["two", "Two Pages", 2], ["scroll", "Scrolling", 3]];
for (const [layout, title, n] of LAYOUTS) {
  defineAction({
    id: `reader.layout.${layout}`,
    title: `Book layout: ${title}`,
    keys: [`Ctrl+Mod+${n}`],
    when: () => !!currentReader()?.view.layout,
    menu: { name: "view", group: 3 + n / 10, title },
    icon: BookOpen,
    run: () => currentReader.peek()?.view.layout?.set(layout),
  });
}

addPanelView({
  id: "about",
  title: "About this item",
  icon: Info,
  applies: (r) => r.page === "item" && !!r.params.id,
  render(host, route) {
    return effect(() => {
      const r = getRecord(route.params.id);
      if (!r) return replace(host);
      const p = (r.fields.provenance ?? {}) as Record<string, unknown>;
      const rows: [string, unknown][] = [["Source", p.source], ["Author", p.author], ["Publication", p.publication], ["Published", p.published], ["Saved", p["saved-at"]], ["Saved with", p["saved-with"]], ["Original file", p["original-name"]], ["SHA-256", r.fields.sha256]];
      replace(host, h("dl", { class: "facts" }, rows.filter(([, v]) => v).map(([k, v]) => [h("dt", null, k), h("dd", null, String(v))])));
    });
  },
});
