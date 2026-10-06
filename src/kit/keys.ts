/**
 * Keyboard shortcuts as strings: "Mod+Shift+P", "Mod+Alt+ArrowLeft", "Mod+\\".
 * Mod is ⌘ on a Mac. Keys are read from `event.code`, so ⌥ combinations work.
 */

/** Librarium runs on macOS only: Mod is always ⌘. */
export const isMac = true;

const CODE_KEYS: Record<string, string> = {
  Backslash: "\\",
  Slash: "/",
  Comma: ",",
  Period: ".",
  Semicolon: ";",
  Quote: "'",
  BracketLeft: "[",
  BracketRight: "]",
  Minus: "-",
  Equal: "=",
  Backquote: "`",
  Space: "Space",
};

const ORDER = ["Mod", "Ctrl", "Alt", "Shift"];

/** Puts a shortcut into canonical form, e.g. "shift+mod+p" → "Mod+Shift+P". */
export function normalize(keys: string): string {
  const parts = keys.split("+").map((p) => p.trim());
  const key = parts.pop() ?? "";
  const mods = parts.map((m) => {
    const l = m.toLowerCase();
    if (l === "mod" || l === "cmd" || l === "meta") return "Mod";
    if (l === "ctrl" || l === "control") return "Ctrl";
    if (l === "alt" || l === "option" || l === "opt") return "Alt";
    if (l === "shift") return "Shift";
    return m;
  });
  mods.sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b));
  const k = key === "" && keys.endsWith("+") ? "+" : key.length === 1 ? key.toUpperCase() : key;
  return [...new Set(mods), k].join("+");
}

/** The shortcut a key event represents, or null for a bare modifier or IME composition. */
export function fromEvent(e: KeyboardEvent): string | null {
  if (e.isComposing || e.keyCode === 229) return null;
  if (["Meta", "Control", "Alt", "Shift"].includes(e.key)) return null;
  let key: string;
  if (e.code.startsWith("Key")) key = e.code.slice(3);
  else if (e.code.startsWith("Digit")) key = e.code.slice(5);
  else if (CODE_KEYS[e.code]) key = CODE_KEYS[e.code]!;
  else key = e.key.length === 1 ? e.key.toUpperCase() : e.key;
  const mods: string[] = [];
  if (isMac ? e.metaKey : e.ctrlKey) mods.push("Mod");
  if (isMac && e.ctrlKey) mods.push("Ctrl");
  if (e.altKey) mods.push("Alt");
  if (e.shiftKey) mods.push("Shift");
  return [...mods, key].join("+");
}

const SYMBOLS: Record<string, string> = { Mod: "⌘", Ctrl: "⌃", Alt: "⌥", Shift: "⇧", ArrowLeft: "←", ArrowRight: "→", ArrowUp: "↑", ArrowDown: "↓", Enter: "↩", Escape: "⎋", Backspace: "⌫", Space: "Space" };

/** "Mod+Shift+P" → "⇧⌘P" (macOS order: ⌃⌥⇧⌘). */
export function display(keys: string): string {
  const parts = normalize(keys).split("+");
  const key = parts.pop()!;
  const order = ["Ctrl", "Alt", "Shift", "Mod"];
  parts.sort((a, b) => order.indexOf(a) - order.indexOf(b));
  return parts.map((p) => SYMBOLS[p] ?? p).join("") + (SYMBOLS[key] ?? key);
}

/** "Mod+Shift+P" → "CmdOrCtrl+Shift+P" for native menu accelerators. */
export function accelerator(keys: string): string {
  return normalize(keys)
    .split("+")
    .map((p) => (p === "Mod" ? "CmdOrCtrl" : p === "Alt" ? "Alt" : p === "ArrowLeft" ? "Left" : p === "ArrowRight" ? "Right" : p === "ArrowUp" ? "Up" : p === "ArrowDown" ? "Down" : p))
    .join("+");
}

const PASS = new WeakSet<KeyboardEvent>();
/**
 * A key the app sends to a component on purpose (⌘Z to a board's canvas): the app's own
 * shortcuts let it through, so it isn't taken for the user pressing it again.
 */
export function passThrough(e: KeyboardEvent): KeyboardEvent {
  PASS.add(e);
  return e;
}
export const isPassThrough = (e: KeyboardEvent) => PASS.has(e);
