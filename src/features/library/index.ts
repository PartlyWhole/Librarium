/** Library: saved pages, PDFs, images and EPUBs. */
import { h, replace } from "../../kit/dom";
import { effect } from "../../kit/signal";
import type { ShellApi } from "../../shell/api";
import { BookOpen, Library as LibraryIcon } from "lucide";

const KIND = "item";

export function library(shell: ShellApi): void {
  shell.openers.add("library", KIND, "item");
  shell.pages.add("library", "library", {
    id: "library",
    title: "Library",
    icon: LibraryIcon,
    ribbon: 2,
    render(host) {
      return effect(() => {
        const items = shell.records.list(KIND).sort((a, b) => a.title.localeCompare(b.title));
        replace(host, h("h1", { class: "page-title" }, "Library"), items.length ? h("ul", { class: "plain-list" }, items.map((i) => h("li", null, i.title || "Untitled"))) : h("p", { class: "empty" }, "No library items yet."));
      });
    },
  });
  shell.pages.add("library", "item", {
    id: "item",
    title: "Item",
    icon: BookOpen,
    render(host, params, ctx) {
      const r = shell.records.get(params.id ?? "");
      ctx.setTitle(r?.title ?? "Item");
      replace(host, h("h1", { class: "page-title" }, r?.title ?? "Item"), h("p", { class: "empty" }, "The reader opens items here."));
    },
  });
  shell.sidebar.add("library", "library", {
    id: "library",
    title: "Library",
    emptyText: "No library items yet.",
    nodes: () => shell.records.list(KIND).sort((a, b) => a.title.localeCompare(b.title)).map((i) => ({ id: i.id, label: i.title || "Untitled", icon: BookOpen, onActivate: () => shell.openRecord(i.id) })),
  }, 1);
}
