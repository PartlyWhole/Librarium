/**
 * The single list of actions. The native menu bar, the command palette, the shortcuts dialog
 * and the key handler are all built from it. Features add theirs with `defineAction` when their
 * module loads.
 */
import { setAppMenu, type MenuEntry, type MenuSection } from "../backend";
import { comboboxDialog } from "../ui/combobox";
import { modal } from "../ui/dialog";
import { h } from "../ui/dom";
import type { IconNode } from "../ui/icon";
import { accelerator, display, fromEvent, isPassThrough, normalize } from "../ui/keys";
import { effect, untracked } from "../ui/signal";

type MenuName = "app" | "file" | "edit" | "format" | "view" | "go" | "window" | "help";

interface Action {
  id: string;
  /** May be a getter (Undo names the step it undoes). */
  title: string;
  /** Shortcuts, e.g. "Mod+Shift+P"; the first is shown. */
  keys?: string[];
  /** Available now? May read signals. Always, by default. */
  when?: () => boolean;
  run: () => void | Promise<void>;
  /**
   * Where it sits in the menu bar: a menu, a place (the whole number is a section, set apart by
   * separators; the fraction its order within it, e.g. 0.3), and its own title there.
   */
  menu?: { name: MenuName; group: number; title?: string };
  icon?: IconNode;
  /** Listed in the command palette (default true). */
  palette?: boolean;
  /** Wins over the editor and the board canvas. */
  reserved?: boolean;
}

const actions: Action[] = [];
const byKey = new Map<string, Action>();

export function defineAction(a: Action): void {
  if (actions.some((x) => x.id === a.id)) throw new Error(`action ${a.id} is defined twice`);
  a.keys = a.keys?.map(normalize);
  for (const k of a.keys ?? []) {
    const other = byKey.get(k);
    if (other) throw new Error(`${k} of ${a.id} is already ${other.id}'s`);
    byKey.set(k, a);
  }
  actions.push(a);
}

export function actionList(): readonly Action[] {
  return actions;
}

export function available(a: Action): boolean {
  try {
    return a.when ? a.when() : true;
  } catch {
    return false;
  }
}

/** Runs an action if it exists and is available; false otherwise. */
export function runAction(id: string): boolean {
  const a = actions.find((x) => x.id === id);
  if (!a || !untracked(() => available(a))) return false;
  void a.run();
  return true;
}

// ---- The menu bar --------------------------------------------------------------------------

const MENUS: [MenuName, string][] = [
  ["app", "Librarium"],
  ["file", "File"],
  ["edit", "Edit"],
  ["format", "Format"],
  ["view", "View"],
  ["go", "Go"],
  ["window", "Window"],
  ["help", "Help"],
];
const SEP: MenuEntry = { kind: "separator" };
const pre = (item: Extract<MenuEntry, { kind: "predefined" }>["item"], text?: string): MenuEntry => ({ kind: "predefined", item, text });

function menuSpec(): MenuSection[] {
  /** A menu's own items in order, a separator between sections (only those `only` keeps). */
  const own = (name: MenuName, only: (group: number) => boolean = () => true): MenuEntry[] => {
    const mine = actions.filter((a) => a.menu?.name === name && only(a.menu.group)).sort((x, y) => x.menu!.group - y.menu!.group);
    return mine.flatMap((a, i) => {
      const item: MenuEntry = { kind: "item", id: a.id, text: a.menu!.title ?? a.title, accelerator: a.keys?.[0] && accelerator(a.keys[0]), enabled: available(a), run: () => runAction(a.id) };
      return i && Math.floor(mine[i - 1]!.menu!.group) !== Math.floor(a.menu!.group) ? [SEP, item] : [item];
    });
  };
  const then = (xs: MenuEntry[]) => (xs.length ? [SEP, ...xs] : []);
  const sections: Record<MenuName, MenuEntry[]> = {
    // Quit is the app's own (group 100, last), so the interface saves before the app ends.
    app: [pre("About", "About Librarium"), ...then(own("app", (g) => g < 100)), SEP, pre("Services"), SEP, pre("Hide"), pre("HideOthers"), pre("ShowAll"), ...then(own("app", (g) => g >= 100))],
    file: own("file"),
    // Undo and Redo are the app's own (group -1), so they can be greyed out. Without the
    // predefined clipboard items, ⌘C and ⌘V stop working.
    edit: [...own("edit", (g) => g < 0), SEP, pre("Cut"), pre("Copy"), pre("Paste"), pre("SelectAll"), ...then(own("edit", (g) => g >= 0))],
    format: own("format"),
    view: [...own("view"), SEP, pre("Fullscreen")],
    go: own("go"),
    window: [pre("Minimize"), pre("Maximize"), ...then(own("window"))],
    help: own("help"),
  };
  return MENUS.map(([name, title]) => ({ title, entries: sections[name] })).filter((s) => s.entries.length);
}

/**
 * Keeps the menu bar current: whenever what an action's `when` or title reads changes, the
 * states are compared and the menu is installed again only if one differs.
 */
function keepMenu(): void {
  let shown = "";
  let timer: ReturnType<typeof setTimeout> | undefined;
  effect(() => {
    const state = actions.map((a) => `${a.id}${available(a) ? "+" : "-"}${a.title}`).join("\n");
    if (state === shown) return;
    shown = state;
    clearTimeout(timer);
    timer = setTimeout(() => void setAppMenu(menuSpec()).catch((e) => console.error("the menu bar could not be installed", e)), 50);
  });
}

// ---- Keys --------------------------------------------------------------------------------

function onKey(e: KeyboardEvent): void {
  if (isPassThrough(e)) return;
  const key = fromEvent(e);
  const a = key ? byKey.get(key) : undefined;
  if (!a) return;
  // In the editor and on a board's canvas, only the app's reserved keys win.
  if ((e.target as Element | null)?.closest?.(".cm-editor, .excalidraw") && !a.reserved) return;
  if (!untracked(() => available(a))) return;
  e.preventDefault();
  e.stopPropagation();
  void a.run();
}

/** Installs the menu bar and the key handler, once every feature has defined its actions. */
export function startActions(): void {
  keepMenu();
  document.addEventListener("keydown", onKey, true);
}

// ---- The palette and the shortcuts dialog ----------------------------------------------------

export function openPalette(): void {
  const list = actions.filter((a) => a.palette !== false && untracked(() => available(a)));
  comboboxDialog({
    label: "Command palette",
    placeholder: "Type a command",
    emptyText: "No command matches.",
    choices: list.map((a) => ({ id: a.id, label: a.title, hint: a.keys?.[0] && display(a.keys[0]), icon: a.icon })),
    onPick: (c) => runAction(c.id),
  });
}

export function openShortcuts(): void {
  const rows = actions.filter((a) => a.keys?.length);
  const m = modal(
    h("div", { class: "shortcuts" },
      h("h2", { class: "ask-title" }, "Keyboard shortcuts"),
      h("table", { class: "shortcut-table" }, h("tbody", null, rows.map((a) => h("tr", null, h("td", null, a.title), h("td", null, h("kbd", null, display(a.keys![0]!))))))),
      h("div", { class: "ask-buttons" }, h("button", { class: "button primary", onclick: () => m.close() }, "Done")),
    ),
    { label: "Keyboard shortcuts" },
  );
  m.el.querySelector("button")?.focus();
}
