/** A tiny element builder. `h("button", { class: "x", "aria-label": "Close", onclick }, "Text")` */

export type Child = Node | string | number | null | undefined | false | Child[];
type Handler = (e: Event) => void;
export type Props = Record<string, unknown> & { class?: string; style?: Partial<CSSStyleDeclaration> | string };

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props | null = null, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === undefined || v === null || v === false) continue;
      if (k.startsWith("on") && typeof v === "function") {
        el.addEventListener(k.slice(2), v as Handler);
      } else if (k === "style" && typeof v === "object") {
        Object.assign(el.style, v);
      } else if (k === "dataset" && typeof v === "object") {
        Object.assign(el.dataset, v);
      } else if (k in el && !k.includes("-") && k !== "list" && k !== "form") {
        (el as unknown as Record<string, unknown>)[k] = v;
      } else {
        el.setAttribute(k, v === true ? "" : String(v));
      }
    }
  }
  append(el, children);
  return el;
}

export function append(parent: Node, children: Child[]): void {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(parent, c);
    else parent.appendChild(typeof c === "string" || typeof c === "number" ? document.createTextNode(String(c)) : c);
  }
}

/** Replaces an element's children. */
export function replace(parent: Element, ...children: Child[]): void {
  parent.replaceChildren();
  append(parent, children);
}

let uid = 0;
/** A unique element ID with a prefix. */
export function uniqueId(prefix: string): string {
  return `${prefix}-${++uid}`;
}

/** True when the user asked the system for less motion. */
export function reducedMotion(): boolean {
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}
