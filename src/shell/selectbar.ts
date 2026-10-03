/**
 * Select mode for a page's list of records: a "Select" button turns it on; then a click ticks an
 * item instead of opening it, and a bar shows how many are selected and what can be done with
 * them (the same entries as the context menu). ⌘A anywhere on the page (outside a text field)
 * selects everything; Escape leaves select mode.
 */
import { h, replace } from "../kit/dom";
import { effect, type Signal } from "../kit/signal";
import type { Selection } from "../kit/selection";
import type { RecordInfo } from "../generated/RecordInfo";
import type { ShellApi } from "./slots";

export interface SelectBar {
  el: HTMLElement;
  dispose(): void;
}

const editable = (t: EventTarget | null) => t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));

export function selectBar(
  shell: ShellApi,
  o: { selection: Selection; mode: Signal<boolean>; items: () => RecordInfo[]; sync: () => void; noun: [string, string] },
): SelectBar {
  const el = h("div", { class: "select-bar", role: "toolbar", "aria-label": "Selection" });
  const stop = effect(() => {
    const on = o.mode();
    const ids = o.selection.ids();
    const items = o.items();
    o.sync();
    if (!on) {
      replace(el, h("button", { class: "button", type: "button", disabled: !items.length, onclick: () => o.mode.set(true) }, "Select"));
      return;
    }
    const chosen = items.filter((r) => ids.has(r.id));
    const n = chosen.length;
    const actions = n ? shell.recordActionsFor(chosen) : [];
    replace(
      el,
      h("span", { class: "select-count", "aria-live": "polite" }, n ? `${n} ${n === 1 ? o.noun[0] : o.noun[1]} selected` : `Click ${o.noun[1]} to select them`),
      ...actions.map((a) => h("button", { class: `button${a.destructive ? " destructive" : ""}`, type: "button", onclick: () => a.run() }, a.label)),
      h("span", { class: "spacer" }),
      n < items.length
        ? h("button", { class: "link-button", type: "button", onclick: () => o.selection.set(items.map((r) => r.id)) }, "Select all")
        : h("button", { class: "link-button", type: "button", onclick: () => o.selection.clear() }, "Select none"),
      h("button", { class: "button", type: "button", onclick: () => (o.selection.clear(), o.mode.set(false)) }, "Done"),
    );
  });
  const onKey = (e: KeyboardEvent) => {
    // A dialog or menu handles its own keys.
    if (document.querySelector("dialog[open], .context-menu")) return;
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "a" && !editable(e.target)) {
      e.preventDefault();
      o.mode.set(true);
      o.selection.set(o.items().map((r) => r.id));
    } else if (e.key === "Escape" && o.mode.peek() && !editable(e.target)) {
      o.selection.clear();
      o.mode.set(false);
    }
  };
  window.addEventListener("keydown", onKey);
  return {
    el,
    dispose() {
      stop();
      window.removeEventListener("keydown", onKey);
    },
  };
}
