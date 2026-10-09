/**
 * Captures: a passage or a region (in one part or several) kept with your own words, always
 * pointing back to its exact place. This adds the capture page and the Captures page, the
 * capture actions in the reader, the side panel's Captures view, captures under their item in
 * the sidebar, and Settings › Captures.
 */
import { call } from "../backend";
import { defineAction } from "../app/actions";
import { addRecordChildren } from "../app/folders";
import { pages } from "../app/pages";
import { openRecord } from "../app/records";
import { router } from "../app/router";
import { setSettingsSection } from "../app/settings";
import { h, replace } from "../ui/dom";
import { untracked } from "../ui/signal";
import { currentReader } from "../reader";
import type { OrphanSidecar } from "../types";
import { renderCaptures } from "./browse";
import { capturesOf } from "./common";
import { captureMenu } from "./delete";
import { controllerFor, draftKey, drafts } from "./draft";
import { renderCapture } from "./page";
import "./panel";
import "./captures.css";
import { Crop, Highlighter, Quote } from "lucide";

pages.capture = { title: "Capture", icon: Quote, render: renderCapture };
// The shell gives it a ribbon button and ⇧⌘K.
pages.captures = { title: "Captures", icon: Quote, render: renderCaptures };

const reader = () => controllerFor(untracked(currentReader));
defineAction({ id: "captures.captureSelection", title: "Capture the selection", keys: ["Mod+Shift+C"], when: () => !!currentReader(), run: () => reader()?.addSelection(), menu: { name: "edit", group: 2 }, icon: Highlighter });
defineAction({ id: "captures.captureRegion", title: "Capture a region", keys: ["Mod+Shift+R"], when: () => !!currentReader()?.view.pickRegion, run: () => reader()?.addRegion(), menu: { name: "edit", group: 2 }, icon: Crop });
defineAction({
  id: "captures.save",
  title: "Save the capture",
  keys: ["Mod+Enter"],
  when: () => {
    const r = currentReader();
    return !!r && !!drafts().get(draftKey(r.source.id, r.snapshot))?.parts.length;
  },
  run: () => reader()?.save(),
  menu: { name: "edit", group: 2 },
});

// An item's captures, folded under it in the sidebar.
addRecordChildren((r) =>
  r.kind !== "item" ? [] : capturesOf(r.id).map((c) => ({
    id: c.id,
    label: c.title || "Capture",
    icon: Quote,
    current: router.current().params.id === c.id,
    onActivate: () => openRecord(c.id),
    onOpenNew: () => openRecord(c.id, {}, { newTab: true }),
    onContext: (at) => captureMenu(c, at),
  })),
);

setSettingsSection("captures", "Captures", (host) => {
  void call<OrphanSidecar[]>("captures.orphans").then((o) => replace(host, o.length
    ? [h("p", { class: "muted small" }, "These files belong to captures that no longer exist. They are kept; you can remove them yourself."), h("ul", { class: "plain-list" }, o.map((x) => h("li", { class: "small" }, x.path)))]
    : h("p", { class: "muted small" }, "Every capture file belongs to a capture.")), () => {});
});
