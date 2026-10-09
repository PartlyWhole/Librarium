/**
 * The WAI-ARIA APG combobox-with-listbox pattern inside a modal <dialog>: the command palette,
 * Open, and the folder picker. Focus stays in the input; ↑/↓ move the active option, Enter
 * picks, Escape closes.
 */
import { h, uniqueId } from "./dom";
import { modal, type Modal } from "./dialog";
import { fuzzyFilter } from "./fuzzy";
import { icon, type IconNode } from "./icon";

export interface Choice {
  id: string;
  label: string;
  detail?: string;
  hint?: string;
  icon?: IconNode;
}

interface ComboboxOptions {
  label: string;
  placeholder: string;
  emptyText: string;
  choices: Choice[];
  onPick: (c: Choice) => void;
  /** Ranks choices for a query; fuzzy matching on the label and detail by default. */
  filter?: (choices: Choice[], query: string) => Choice[];
}

export function comboboxDialog(opts: ComboboxOptions): Modal {
  const listId = uniqueId("listbox");
  const input = h("input", { class: "combo-input", type: "text", role: "combobox", "aria-expanded": "true", "aria-controls": listId, "aria-autocomplete": "list", "aria-label": opts.label, placeholder: opts.placeholder, autocomplete: "off", spellcheck: false });
  const list = h("ul", { id: listId, role: "listbox", class: "combo-list", "aria-label": opts.label });
  const empty = h("div", { class: "combo-empty", hidden: true }, opts.emptyText);
  const filter = opts.filter ?? ((cs, q) => fuzzyFilter(cs, q, (c) => `${c.label} ${c.detail ?? ""}`));
  let shown: Choice[] = [];
  let active = 0;

  const optionId = (i: number) => `${listId}-o${i}`;
  const paintActive = () => {
    for (const [i, li] of [...list.children].entries()) li.setAttribute("aria-selected", String(i === active));
    if (shown.length) {
      input.setAttribute("aria-activedescendant", optionId(active));
      list.children[active]?.scrollIntoView({ block: "nearest" });
    } else input.removeAttribute("aria-activedescendant");
  };
  const render = () => {
    shown = filter(opts.choices, input.value);
    active = 0;
    list.replaceChildren(
      ...shown.map((c, i) =>
        h("li", { id: optionId(i), role: "option", class: "combo-option", "aria-selected": "false", onmousedown: (e: Event) => e.preventDefault(), onclick: () => pick(i) },
          c.icon ? icon(c.icon, 16) : null,
          h("span", { class: "combo-label" }, c.label),
          c.detail ? h("span", { class: "combo-detail" }, c.detail) : null,
          c.hint ? h("kbd", { class: "combo-hint" }, c.hint) : null,
        ),
      ),
    );
    empty.hidden = shown.length > 0;
    paintActive();
  };
  const pick = (i: number) => {
    const c = shown[i];
    if (!c) return;
    m.close();
    opts.onPick(c);
  };
  input.addEventListener("input", render);
  input.addEventListener("keydown", (e) => {
    if (e.isComposing) return;
    if (e.key === "ArrowDown") active = Math.min(active + 1, shown.length - 1);
    else if (e.key === "ArrowUp") active = Math.max(active - 1, 0);
    else if (e.key === "Enter") return void (e.preventDefault(), pick(active));
    else return;
    e.preventDefault();
    paintActive();
  });
  const m = modal(h("div", { class: "combo" }, input, list, empty), { label: opts.label, className: "combo-dialog" });
  render();
  input.focus();
  return m;
}
