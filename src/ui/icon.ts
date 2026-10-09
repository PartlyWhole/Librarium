/** Lucide line icons, monochrome, sized for the UI. */
import { createElement, type IconNode } from "lucide";
import { h } from "./dom";
import { display } from "./keys";

export type { IconNode };

export function icon(node: IconNode, size = 18): SVGElement {
  const svg = createElement(node, { width: size, height: size, "stroke-width": 1.75, "aria-hidden": "true", focusable: "false" });
  svg.classList.add("icon");
  return svg;
}

/** A labelled icon button; its tooltip names its shortcut. */
export function iconButton(node: IconNode, label: string, run: (e: MouseEvent) => void, keys?: string, size?: number): HTMLButtonElement {
  return h("button", { class: "icon-button", type: "button", "aria-label": label, title: keys ? `${label} (${display(keys)})` : label, onclick: run }, icon(node, size));
}
