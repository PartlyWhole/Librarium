/**
 * Modal dialogs on the native <dialog> element: focus moves in and is restored on close,
 * Escape closes, the backdrop is dimmed. Dialogs are only for conflicts and destructive
 * confirmations (and the palette, shortcuts and open dialogs).
 */
import { h, uniqueId, type Child } from "./dom";

export interface ModalOptions {
  label: string;
  className?: string;
  onClose?: () => void;
}

export interface Modal {
  el: HTMLDialogElement;
  close(): void;
}

export function modal(content: Child, opts: ModalOptions): Modal {
  const previous = document.activeElement as HTMLElement | null;
  const el = h("dialog", { class: `modal ${opts.className ?? ""}`, "aria-label": opts.label }, content);
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    if (el.open && typeof el.close === "function") el.close();
    el.remove();
    previous?.focus?.();
    opts.onClose?.();
  };
  el.addEventListener("cancel", (e) => {
    e.preventDefault();
    close();
  });
  el.addEventListener("close", close);
  el.addEventListener("mousedown", (e) => {
    if (e.target === el) close();
  });
  document.body.appendChild(el);
  if (typeof el.showModal === "function") el.showModal();
  else el.setAttribute("open", "");
  return { el, close };
}

export interface ChoiceButton<T> {
  label: string;
  value: T;
  primary?: boolean;
  destructive?: boolean;
}

/** Asks a question with buttons; resolves with the chosen value, or null if dismissed. */
export function ask<T>(title: string, body: Child, buttons: ChoiceButton<T>[]): Promise<T | null> {
  return new Promise((resolve) => {
    let result: T | null = null;
    const titleId = uniqueId("dlg-title");
    const btns = buttons.map((b) =>
      h("button", {
        class: `button ${b.primary ? "primary" : ""} ${b.destructive ? "destructive" : ""}`,
        onclick: () => {
          result = b.value;
          m.close();
        },
      }, b.label),
    );
    const m = modal(
      h("div", { class: "ask" }, h("h2", { id: titleId, class: "ask-title" }, title), h("div", { class: "ask-body" }, body), h("div", { class: "ask-buttons" }, btns)),
      { label: title, onClose: () => resolve(result) },
    );
    m.el.setAttribute("aria-labelledby", titleId);
    m.el.removeAttribute("aria-label");
    (btns.find((_, i) => buttons[i]!.primary) ?? btns[0])?.focus();
  });
}
