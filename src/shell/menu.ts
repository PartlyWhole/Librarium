/** The native macOS menu bar, generated from the action registry. */
import { setAppMenu, type MenuEntry, type MenuSection } from "../backend";
import { accelerator } from "../kit/keys";
import type { Actions, MenuName } from "./actions";

const TITLES: [MenuName, string][] = [
  ["app", "Librarium"],
  ["file", "File"],
  ["edit", "Edit"],
  ["format", "Format"],
  ["view", "View"],
  ["go", "Go"],
  ["window", "Window"],
  ["help", "Help"],
];

/** The menu as data (tested without Tauri). */
export function menuSpec(actions: Actions): MenuSection[] {
  const groups = new Map<MenuName, Map<number, MenuEntry[]>>();
  for (const a of actions.all()) {
    if (!a.menu) continue;
    const g = groups.get(a.menu.name) ?? new Map<number, MenuEntry[]>();
    groups.set(a.menu.name, g);
    const list = g.get(a.menu.group) ?? [];
    g.set(a.menu.group, list);
    list.push({ kind: "item", id: a.id, text: a.menu.title ?? a.title, accelerator: a.keys?.[0] ? accelerator(a.keys[0]) : undefined, enabled: actions.available(a), run: () => actions.run(a.id) });
  }
  const custom = (name: MenuName, only?: (group: number) => boolean): MenuEntry[] => {
    const g = groups.get(name);
    if (!g) return [];
    const out: MenuEntry[] = [];
    for (const k of [...g.keys()].sort((a, b) => a - b).filter((k) => !only || only(k))) {
      if (out.length) out.push({ kind: "separator" });
      out.push(...g.get(k)!);
    }
    return out;
  };
  const sep: MenuEntry = { kind: "separator" };
  const withSep = (xs: MenuEntry[]) => (xs.length ? [...xs, sep] : []);
  const sections: Record<MenuName, MenuEntry[]> = {
    app: [{ kind: "predefined", item: "About", text: "About Librarium" }, sep, ...withSep(custom("app")), { kind: "predefined", item: "Services" }, sep, { kind: "predefined", item: "Hide" }, { kind: "predefined", item: "HideOthers" }, { kind: "predefined", item: "ShowAll" }, sep, { kind: "predefined", item: "Quit" }],
    // "Close window" is the app's own (⇧⌘W): ⌘W closes a tab.
    file: custom("file"),
    // Without these, ⌘C and ⌘V stop working in a Tauri app. Undo and Redo are the app's own
    // (group -1), so they can be greyed out when there's nothing to undo.
    edit: [...withSep(custom("edit", (g) => g < 0)), { kind: "predefined", item: "Cut" }, { kind: "predefined", item: "Copy" }, { kind: "predefined", item: "Paste" }, { kind: "predefined", item: "SelectAll" }, ...(custom("edit", (g) => g >= 0).length ? [sep, ...custom("edit", (g) => g >= 0)] : [])],
    format: custom("format"),
    view: [...withSep(custom("view")), { kind: "predefined", item: "Fullscreen" }],
    go: custom("go"),
    window: [{ kind: "predefined", item: "Minimize" }, { kind: "predefined", item: "Maximize" }, ...(custom("window").length ? [sep, ...custom("window")] : [])],
    help: custom("help"),
  };
  return TITLES.map(([name, title]) => ({ title, entries: sections[name] })).filter((s) => s.entries.length > 0);
}

let timer: ReturnType<typeof setTimeout> | undefined;
let installs = 0;

/** (Re)installs the menu, debounced: enabled states follow each action's `when`. */
export function refreshMenu(actions: Actions): void {
  clearTimeout(timer);
  timer = setTimeout(() => void setAppMenu(menuSpec(actions)).then(() => (installs++ === 0 ? console.info("native menu installed") : undefined)).catch((e) => console.error("the native menu could not be installed", e)), 50);
}
