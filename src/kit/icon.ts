/** Lucide line icons, monochrome, sized for the UI. */
import { createElement, type IconNode } from "lucide";

export type { IconNode };

export function icon(node: IconNode, size = 18): SVGElement {
  const svg = createElement(node, { width: size, height: size, "stroke-width": 1.75, "aria-hidden": "true", focusable: "false" });
  svg.classList.add("icon");
  return svg;
}
