/**
 * The side panel: one view at a time, chosen by icons along its top (as in Obsidian's right
 * sidebar). Only the views that apply to the page shown are offered; the choice is remembered.
 * Features add views with `addPanelView`.
 */
import { h, replace } from "../ui/dom";
import { icon, iconButton, type IconNode } from "../ui/icon";
import { effect, untracked } from "../ui/signal";
import { pref } from "./prefs";
import { router, type Route } from "./router";
import { X } from "lucide";

export interface PanelView {
  id: string;
  title: string;
  icon: IconNode;
  applies(route: Route): boolean;
  /** Fills `host` for this route; returns a disposer. */
  render(host: HTMLElement, route: Route): (() => void) | void;
}

/** The views' order along the top; views not listed come last. */
const ORDER = ["links", "outline", "history", "captures", "about", "jobs"];
const rank = (v: PanelView) => (ORDER.indexOf(v.id) + ORDER.length + 1) % (ORDER.length + 1);
const views: PanelView[] = [];

export function addPanelView(v: PanelView): void {
  views.push(v);
  views.sort((a, b) => rank(a) - rank(b));
}

export const panelOpen = pref("ui.sidePanel", false);
const chosen = pref("ui.panelView", "links");

/** Opens the panel at a view (e.g. "jobs"), and focuses it. */
export function showPanelView(id: string): void {
  chosen.set(id);
  panelOpen.set(true);
  setTimeout(() => document.querySelector<HTMLElement>(`.panel-section[data-view="${id}"]`)?.focus({ preventScroll: true }), 0);
}

/** The panel element; `close` is the button that hides it. */
export function sidePanel(onClose: () => void): HTMLElement {
  const tabs = h("div", { class: "panel-tabs", role: "tablist", "aria-label": "Side panel views" });
  const body = h("div", { class: "side-panel-body" });
  const close = iconButton(X, "Close the side panel", onClose, "Mod+Alt+\\", 15);
  const el = h("aside", { class: "side-panel", "aria-label": "Side panel" }, h("div", { class: "side-panel-head" }, tabs, close), body);
  let dispose: (() => void) | void;
  effect(() => {
    const r = router.current();
    const want = chosen();
    if (dispose) dispose();
    dispose = undefined;
    if (!panelOpen()) return replace(body);
    const offered = views.filter((v) => v.applies(r));
    const shown = offered.find((v) => v.id === want) ?? offered[0];
    replace(tabs, offered.map((v, i) => {
      const on = v === shown;
      const b = h("button", { class: `icon-button panel-tab${on ? " current" : ""}`, type: "button", role: "tab", "aria-selected": String(on), tabindex: on ? "0" : "-1", "aria-label": v.title, title: v.title, dataset: { view: v.id }, onclick: () => chosen.set(v.id) }, icon(v.icon, 16));
      b.addEventListener("keydown", (e) => {
        const to = e.key === "ArrowRight" ? offered[(i + 1) % offered.length] : e.key === "ArrowLeft" ? offered[(i - 1 + offered.length) % offered.length] : undefined;
        if (!to) return;
        e.preventDefault();
        chosen.set(to.id);
        setTimeout(() => tabs.querySelector<HTMLElement>(`[data-view="${to.id}"]`)?.focus(), 0);
      });
      return b;
    }));
    if (!shown) return replace(body, h("p", { class: "empty" }, "Nothing more to show here."));
    const host = h("div", { class: "panel-body" });
    dispose = untracked(() => shown.render(host, r));
    replace(body, h("section", { class: "panel-section", role: "tabpanel", "aria-label": shown.title, tabindex: "-1", dataset: { view: shown.id } }, h("h2", { class: "panel-title" }, shown.title), host));
  });
  return el;
}
