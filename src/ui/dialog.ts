/**
 * Modal dialogs on the native <dialog> element: focus moves in and is given back on close,
 * Escape closes, the backdrop is dimmed. Dialogs are only for conflicts and destructive
 * confirmations (and the palette, shortcuts and pickers).
 */
import { h, uniqueId, type Child } from "./dom";

export interface Modal {
  el: HTMLDialogElement;
  close(): void;
}

export function modal(content: Child, opts: { label: string; className?: string; onClose?: () => void }): Modal {
  const previous = document.activeElement as HTMLElement | null;
  const el = h("dialog", { class: `modal ${opts.className ?? ""}`, "aria-label": opts.label }, content);
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    if (el.open) el.close();
    el.remove();
    previous?.focus?.();
    opts.onClose?.();
  };
  el.addEventListener("cancel", (e) => (e.preventDefault(), close()));
  el.addEventListener("close", close);
  el.addEventListener("mousedown", (e) => e.target === el && close());
  document.body.appendChild(el);
  el.showModal();
  return { el, close };
}

interface ChoiceButton<T> {
  label: string;
  value: T;
  primary?: boolean;
  destructive?: boolean;
}

/** A titled dialog with a body and buttons; `buttons` gets the function that closes it. */
function frame(title: string, body: Child, buttons: (close: () => void) => HTMLElement[], onClose: () => void): Modal {
  const titleId = uniqueId("dlg-title");
  let m: Modal | null = null;
  const btns = buttons(() => m?.close());
  m = modal(h("div", { class: "ask" }, h("h2", { id: titleId, class: "ask-title" }, title), h("div", { class: "ask-body" }, body), h("div", { class: "ask-buttons" }, btns)), { label: title, onClose });
  m.el.setAttribute("aria-labelledby", titleId);
  m.el.removeAttribute("aria-label");
  return m;
}

/** Asks a question with buttons; resolves with the chosen value, or null if dismissed. */
export function ask<T>(title: string, body: Child, buttons: ChoiceButton<T>[]): Promise<T | null> {
  return new Promise((resolve) => {
    let result: T | null = null;
    let first: HTMLElement | undefined;
    frame(title, body, (close) =>
      buttons.map((b) => {
        const el = h("button", { class: `button${b.primary ? " primary" : ""}${b.destructive ? " destructive" : ""}`, onclick: () => ((result = b.value), close()) }, b.label);
        if (b.primary || !first) first = el;
        return el;
      }), () => resolve(result));
    first?.focus();
  });
}

/** Cancel or `action`; resolves true when the action was chosen. */
export async function confirm(title: string, body: Child, action: string, o: { destructive?: boolean } = {}): Promise<boolean> {
  const r = await ask(title, body, [{ label: "Cancel", value: false }, { label: action, value: true, primary: !o.destructive, destructive: o.destructive }]);
  return r === true;
}

/**
 * Asks for a line of text. `check` says why a value can't be used (shown under the field), or
 * null when it can. Resolves with the trimmed text, or null if cancelled.
 */
export function prompt(title: string, o: { value?: string; label: string; action: string; check?: (v: string) => string | null }): Promise<string | null> {
  return new Promise((resolve) => {
    let result: string | null = null;
    const input = h("input", { class: "combo-input", value: o.value ?? "", "aria-label": o.label, spellcheck: false });
    const error = h("p", { class: "muted small", "aria-live": "polite" });
    let close = () => {};
    const submit = () => {
      const bad = o.check ? o.check(input.value) : input.value.trim() ? null : `${o.label} can’t be empty.`;
      if (bad) return void (error.textContent = bad);
      result = input.value.trim();
      close();
    };
    input.addEventListener("keydown", (e) => e.key === "Enter" && !e.isComposing && (e.preventDefault(), submit()));
    frame(title, [input, error], (c) => {
      close = c;
      return [h("button", { class: "button", type: "button", onclick: c }, "Cancel"), h("button", { class: "button primary", type: "button", onclick: submit }, o.action)];
    }, () => resolve(result));
    input.focus();
    input.select();
  });
}
