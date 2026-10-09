/**
 * Two side-panel views: Links (what links to the record shown, with context; for a note, also
 * its links without a target) and Outline (the shown note's headings; a click goes there).
 */
import { EditorView } from "@codemirror/view";
import { call, on } from "../backend";
import { addPanelView } from "../app/panel";
import { canOpen, listRecords, openRecord, recordIcon } from "../app/records";
import { editorChanged } from "../app/undo";
import { comboboxDialog } from "../ui/combobox";
import { errorText, h, replace } from "../ui/dom";
import { effect } from "../ui/signal";
import { toast } from "../ui/toast";
import type { Backlink, Unresolved } from "../types";
import { outline } from "./editor/stats";
import { noteView } from "./page";
import { Link2, ListTree } from "lucide";

const LINKED = new Set(["note", "item", "capture", "board"]);

/** Choose its target…: picks the record an unresolved link should point at. */
function chooseTarget(u: Unresolved): void {
  comboboxDialog({
    label: `Link “${u.label}” to`,
    placeholder: "Type a title",
    emptyText: "Nothing has that title.",
    choices: listRecords().filter(canOpen).map((r) => ({ id: r.id, label: r.title || "Untitled", detail: r.kind === "note" ? undefined : r.kind, icon: recordIcon(r) })),
    onPick: (c) => void call("links.resolve", { source: u.source, label: u.label, target: c.id }).then(() => toast(`Linked to “${c.label}”.`), (e) => toast(errorText(e))),
  });
}

addPanelView({
  id: "links",
  title: "Links",
  icon: Link2,
  applies: (r) => !!r.params.id && LINKED.has(r.page),
  render(host, route) {
    const id = route.params.id!;
    const note = route.page === "note";
    let alive = true;
    const load = async () => {
      let back: Backlink[];
      try {
        back = await call<Backlink[]>("links.backlinks", { id });
      } catch (e) {
        if (alive) replace(host, h("p", { class: "muted small" }, errorText(e)));
        return;
      }
      const loose = note ? await call<Unresolved[]>("links.unresolved", { id }).catch(() => [] as Unresolved[]) : [];
      if (!alive) return;
      replace(host,
        h("h3", { class: "panel-subtitle" }, "Linked from"),
        back.length
          ? h("ul", { class: "backlinks" }, back.map((b) => h("li", null,
              h("a", { href: "#", class: "list-link", onclick: (e: MouseEvent) => (e.preventDefault(), openRecord(b.source, b.kind === "note" ? { at: String(b.offset) } : {}, { newTab: e.metaKey })) }, b.title || "Untitled"),
              b.context ? h("div", { class: "muted small" }, b.context) : null)))
          : h("p", { class: "muted small" }, "Nothing links here yet."),
        loose.length
          ? [h("h3", { class: "panel-subtitle" }, "Links without a target"), h("ul", { class: "backlinks" }, loose.map((u) => h("li", null, h("span", null, `“${u.label}” `), h("button", { class: "link-button", type: "button", onclick: () => chooseTarget(u) }, "Choose its target…"))))]
          : null,
      );
    };
    void load();
    // The index has changed: look again (once things settle).
    let timer: ReturnType<typeof setTimeout> | undefined;
    const off = on("records.changed", () => {
      clearTimeout(timer);
      timer = setTimeout(() => void load(), 300);
    });
    return () => {
      alive = false;
      clearTimeout(timer);
      off();
    };
  },
});

/** The headings of a note's editor, as buttons that go there. */
function paintOutline(host: HTMLElement, view: EditorView): void {
  const heads = outline(view.state);
  if (!heads.length) return replace(host, h("p", { class: "muted small" }, "Headings in this note (# Heading) show here."));
  const top = Math.min(...heads.map((x) => x.level));
  replace(host, h("ul", { class: "outline" }, heads.map((x) => h("li", { style: { paddingLeft: `${(x.level - top) * 14}px` } },
    h("button", { class: "outline-link", type: "button", onclick: () => {
      view.dispatch({ selection: { anchor: x.from }, effects: EditorView.scrollIntoView(x.from, { y: "start", yMargin: 24 }) });
      view.focus();
    } }, x.text)))));
}

addPanelView({
  id: "outline",
  title: "Outline",
  icon: ListTree,
  applies: (r) => r.page === "note",
  render(host, route) {
    const id = route.params.id ?? "";
    let shown: unknown = null;
    // The note changes as it is written: follow it (only when its text changed).
    return effect(() => {
      editorChanged();
      const view = noteView(id);
      if (!view || view.state.doc === shown) return;
      shown = view.state.doc;
      paintOutline(host, view);
    });
  },
});
