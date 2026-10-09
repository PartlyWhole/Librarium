/**
 * The side panel's Captures view, on an item and on one of its captures: the draft being made
 * from the source, then the source's captures, oldest first, with the open one marked and
 * moved or lost badges. Each row offers Show, Edit selection, Copy embed and Delete, and a
 * right-click menu. The capture whose parts are being edited shows its name and parts instead,
 * with Cancel and Save changes.
 */
import { addPanelView } from "../app/panel";
import { getRecord, openRecord } from "../app/records";
import { recordScope } from "../app/undo";
import { h, replace } from "../ui/dom";
import { icon, iconButton } from "../ui/icon";
import { effect } from "../ui/signal";
import { anchorOf, capturesOf, copyEmbed, showInSource, sourceOf, statuses, worst } from "./common";
import { captureMenu, deleteCapture } from "./delete";
import { drafts, draftShown, saveDraft, setDraft, type Draft } from "./draft";
import { Copy, LocateFixed, Pencil, Quote, Trash2, X } from "lucide";

addPanelView({
  id: "captures",
  title: "Captures",
  icon: Quote,
  applies: (r) => (r.page === "item" || r.page === "capture") && !!r.params.id,
  render(host, route) {
    const open = route.page === "capture" ? route.params.id! : null;
    const src = open ? sourceOf(getRecord(open)) : route.params.id!;
    const scope = recordScope(route.params.id!);
    const statusOf = new Map<string, string>();
    let alive = true;
    const draftHost = h("div", { class: "capture-draft-host" });
    const listHost = h("div");
    replace(host, draftHost, listHost);
    const stopDraft = effect(() => {
      const d = draftShown();
      if (d?.source === src) d.el.parentElement !== draftHost && replace(draftHost, d.el);
      else draftHost.replaceChildren();
    });
    const stop = effect(() => {
      const list = capturesOf(src);
      const editing = [...drafts()].find(([, d]) => d.editing && list.some((c) => c.id === d.editing!.id));
      if (!list.length) return replace(listHost, draftShown()?.source === src ? null : h("p", { class: "muted small" }, "Nothing captured here yet. Select a passage and choose Capture."));
      const ul = h("ul", { class: "backlinks capture-list" });
      replace(listHost, ul);
      for (const c of list) {
        const status = h("span", { class: `badge ${statusOf.get(c.id) ?? ""}` }, statusOf.get(c.id) === "moved" ? "moved — check it" : (statusOf.get(c.id) ?? ""));
        const mine = editing?.[1].editing?.id === c.id ? editing : null;
        const li = h("li", { class: `capture-row${c.id === open ? " current" : ""}${mine ? " editing" : ""}`, "aria-current": c.id === open ? "true" : undefined },
          mine ? titleField(mine[0], mine[1]) : h("a", { href: "#", class: "list-link", onclick: (e: MouseEvent) => (e.preventDefault(), openRecord(c.id, {}, { newTab: e.metaKey })) }, c.title || "Capture"),
          " ", status,
          mine ? editingControls(mine[0], mine[1]) : h("div", { class: "row tight capture-tools" },
            iconButton(LocateFixed, "Show in the source", () => showInSource(c), undefined, 15),
            iconButton(Pencil, "Edit selection", () => showInSource(c, { edit: true }), undefined, 15),
            iconButton(Copy, "Copy embed", () => copyEmbed(c), undefined, 15),
            iconButton(Trash2, "Delete", () => void deleteCapture(c, scope), undefined, 15)));
        li.addEventListener("contextmenu", (e) => (e.preventDefault(), captureMenu(c, { x: e.clientX, y: e.clientY }, scope)));
        ul.appendChild(li);
        // Found again each time (a confirmed place changes only the anchor), shown as last known meanwhile.
        void anchorOf(c.id).then(statuses).then((st) => {
          if (!alive) return;
          const w = worst(st);
          statusOf.set(c.id, w);
          status.textContent = w === "moved" ? "moved — check it" : w;
          status.className = `badge ${w}`;
        }, () => {});
      }
      if (open) ul.querySelector(".current")?.scrollIntoView?.({ block: "nearest" });
    });
    return () => {
      alive = false;
      stop();
      stopDraft();
    };
  },
});

/** The name of a capture being edited, saved with its parts. */
function titleField(k: string, d: Draft): HTMLElement {
  const input = h("input", { class: "edit-title", type: "text", value: d.editing!.title, "aria-label": "Name of the capture", spellcheck: true });
  // Kept in the draft without drawing the list again (which would take the focus away).
  input.addEventListener("input", () => {
    const cur = drafts.peek().get(k);
    if (cur?.editing) drafts.peek().set(k, { ...cur, editing: { ...cur.editing, title: input.value } });
  });
  input.addEventListener("keydown", (e) => e.key === "Enter" && !e.isComposing && (e.preventDefault(), saveDraft(k)));
  return input;
}

/** The parts of a capture being edited, with Cancel and Save changes. */
function editingControls(k: string, d: Draft): HTMLElement {
  return h("div", { class: "edit-controls" },
    h("p", { class: "edit-hint" }, "Drag the handles at a passage’s ends, or a region’s frame. Select more to add a part."),
    d.parts.map((p, i) => h("div", { class: "edit-part" },
      p.preview ? h("img", { class: "edit-part-img", src: p.preview, alt: "A captured picture" }) : h("span", { class: "edit-part-text" }, p.quote.length > 90 ? `${p.quote.slice(0, 90)}…` : p.quote),
      h("button", { type: "button", class: "icon-button small", "aria-label": `Remove part ${i + 1}`, title: "Remove this part", onclick: () => setDraft(k, { ...d, parts: d.parts.filter((x) => x !== p) }) }, icon(X, 14)))),
    h("div", { class: "ask-buttons" },
      h("button", { class: "button", type: "button", onclick: () => setDraft(k, null) }, "Cancel"),
      h("button", { class: "button primary", type: "button", title: "Save changes (⌘↩)", disabled: !d.parts.length, onclick: () => saveDraft(k) }, "Save changes")));
}
