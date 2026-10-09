/**
 * The app's own actions: the palette and pickers, tabs, going places, the library folder,
 * undo, the look, quitting. Their order here is their order in the menus.
 */
import { call } from "../backend";
import { comboboxDialog } from "../ui/combobox";
import { errorText } from "../ui/dom";
import { toast } from "../ui/toast";
import type { Written } from "../types";
import { defineAction, openPalette, openShortcuts } from "./actions";
import { folderOf } from "./folders";
import { anyJobs, cancelAll, rebuildIndex } from "./jobs";
import { chooseFolder, isOpen } from "./library";
import { panelOpen } from "./panel";
import { pages } from "./pages";
import { pref } from "./prefs";
import { quit } from "./quit";
import { canOpen, listRecords, openRecord, putRecord, recordIcon } from "./records";
import { router } from "./router";
import { revealFolder, revealLogs, theme } from "./settings";
import { lastStep, nextStep, redo, redoHere, redoLast, undo, undoHere, undoLast } from "./undo";
import { Archive, CalendarDays, Command, Files, Keyboard, Library, Plus, Quote, Search, Settings } from "lucide";

export const sidebarOpen = pref("ui.sidebar", true);

let todayRunning: Promise<void> | null = null;
/** Opens today's note, which the backend makes if it is missing (a double press makes one). */
export function openToday(): Promise<void> {
  todayRunning ??= call<Written>("daily.today")
    .then((w) => (putRecord(w.info), router.go("note", { id: w.info.id })), (e) => toast(errorText(e)))
    .finally(() => (todayRunning = null));
  return todayRunning;
}

/** Open… (⌘O): every record that can be opened, by title. */
function openQuick(): void {
  const list = listRecords().filter(canOpen).sort((a, b) => a.title.localeCompare(b.title));
  comboboxDialog({
    label: "Open a note or library item",
    placeholder: "Type a title",
    emptyText: "Nothing has that title.",
    choices: list.map((r) => ({ id: r.id, label: r.title || "Untitled", detail: r.kind === "note" ? folderOf(r) : r.kind, icon: recordIcon(r) })),
    onPick: (c) => openRecord(c.id),
  });
}

// ---- Librarium --------------------------------------------------------------------------------
defineAction({ id: "app.settings", title: "Settings", keys: ["Mod+,"], reserved: true, run: () => router.go("settings"), menu: { name: "app", group: 0, title: "Settings…" }, icon: Settings });
defineAction({ id: "app.quit", title: "Quit Librarium", keys: ["Mod+Q"], reserved: true, palette: false, run: quit, menu: { name: "app", group: 100 } });

// ---- File -------------------------------------------------------------------------------------
defineAction({ id: "tabs.new", title: "New tab", keys: ["Mod+T"], reserved: true, run: () => router.newTab(), menu: { name: "file", group: 0.1 }, icon: Plus });
defineAction({ id: "tabs.reopen", title: "Reopen closed tab", keys: ["Mod+Shift+T"], reserved: true, when: () => (router.tabs(), router.canReopen), run: () => router.reopen(), menu: { name: "file", group: 0.2 } });
defineAction({ id: "app.open", title: "Open a note or library item…", keys: ["Mod+O"], reserved: true, when: isOpen, run: openQuick, menu: { name: "file", group: 1.1, title: "Open…" } });
defineAction({ id: "app.chooseFolder", title: "Choose library folder…", run: chooseFolder, menu: { name: "file", group: 8.1 } });
defineAction({ id: "app.revealFolder", title: "Show library folder in Finder", when: isOpen, run: revealFolder, menu: { name: "file", group: 8.2 } });
defineAction({ id: "jobs.cancelAll", title: "Cancel all jobs", when: anyJobs, run: cancelAll, menu: { name: "file", group: 8.3 } });
defineAction({ id: "index.rebuild", title: "Rebuild index", when: isOpen, run: rebuildIndex, menu: { name: "file", group: 8.4 } });
defineAction({ id: "tabs.close", title: "Close tab", keys: ["Mod+W"], reserved: true, run: () => router.close(), menu: { name: "file", group: 9.1 } });
// Closing the window quits (after saving).
defineAction({ id: "app.closeWindow", title: "Close window", keys: ["Mod+Shift+W"], reserved: true, run: quit, menu: { name: "file", group: 9.2 } });

// ---- Edit -------------------------------------------------------------------------------------
defineAction({ id: "edit.undo", get title() { const l = undoHere().label; return l ? `Undo ${l}` : "Undo"; }, keys: ["Mod+Z"], reserved: true, palette: false, when: () => undoHere().can, run: undo, menu: { name: "edit", group: -1.1 } });
defineAction({ id: "edit.redo", get title() { const l = redoHere().label; return l ? `Redo ${l}` : "Redo"; }, keys: ["Mod+Shift+Z"], reserved: true, palette: false, when: () => redoHere().can, run: redo, menu: { name: "edit", group: -1.2 } });
defineAction({ id: "edit.undoLast", title: "Undo the last move, rename or archiving", when: () => lastStep() !== null, run: undoLast, menu: { name: "edit", group: 0.1 } });
defineAction({ id: "edit.redoLast", title: "Redo the last move, rename or archiving", when: () => nextStep() !== null, run: redoLast, menu: { name: "edit", group: 0.2 } });

// ---- View -------------------------------------------------------------------------------------
defineAction({ id: "app.palette", title: "Command palette", keys: ["Mod+Shift+P"], reserved: true, palette: false, run: openPalette, menu: { name: "view", group: 0 }, icon: Command });
defineAction({ id: "app.toggleSidebar", title: "Toggle sidebar", keys: ["Mod+\\"], reserved: true, run: () => sidebarOpen.update((v) => !v), menu: { name: "view", group: 1.1 } });
defineAction({ id: "app.togglePanel", title: "Toggle side panel", keys: ["Mod+Alt+\\"], reserved: true, run: () => panelOpen.update((v) => !v), menu: { name: "view", group: 1.2 } });
for (const [t, label] of [["system", "follow the system"], ["light", "light"], ["dark", "dark"]] as const) {
  defineAction({ id: `app.theme.${t}`, title: `Theme: ${label}`, run: () => theme.set(t), menu: { name: "view", group: 2 } });
}

// ---- Go ---------------------------------------------------------------------------------------
/** A ribbon page: its page (absent until a feature adds it), title, icon and keys. */
const GO: [page: string, title: string, icon: typeof Files, keys?: string][] = [
  ["notes", "Notes", Files],
  ["library", "Library", Library],
  ["captures", "Captures", Quote, "Mod+Shift+K"],
  ["search", "Search", Search, "Mod+Shift+F"],
  ["archive", "Archive", Archive],
];

/** The ribbon's actions, in order; set by `defineGoActions` once every page exists. */
export const ribbon: string[] = [];

/** Defines Today and the Go actions for the pages that exist (call after features load). */
export function defineGoActions(): void {
  defineAction({ id: "go.today", title: "Today", keys: ["Mod+Shift+D"], reserved: true, when: isOpen, run: openToday, menu: { name: "go", group: 0 }, icon: CalendarDays });
  ribbon.push("go.today");
  for (const [page, title, icon, keys] of GO) {
    if (!pages[page]) continue;
    // From the New tab page, the page takes its place.
    const run = () => router.go(page, {}, { replace: router.current.peek().page === "newtab" });
    defineAction({ id: `go.${page}`, title: `Go to ${title}`, keys: keys ? [keys] : undefined, reserved: true, when: isOpen, run, menu: { name: "go", group: 0, title }, icon });
    ribbon.push(`go.${page}`);
  }
  defineAction({ id: "go.back", title: "Back", keys: ["Mod+Alt+ArrowLeft"], reserved: true, when: () => router.canBack(), run: () => router.back(), menu: { name: "go", group: 1.1 } });
  defineAction({ id: "go.forward", title: "Forward", keys: ["Mod+Alt+ArrowRight"], reserved: true, when: () => router.canForward(), run: () => router.forward(), menu: { name: "go", group: 1.2 } });
}

// ---- Window -----------------------------------------------------------------------------------
defineAction({ id: "tabs.next", title: "Next tab", keys: ["Ctrl+Tab", "Mod+Shift+]"], reserved: true, when: () => router.tabs().length > 1, run: () => router.cycle(1), menu: { name: "window", group: 0.1 } });
defineAction({ id: "tabs.previous", title: "Previous tab", keys: ["Ctrl+Shift+Tab", "Mod+Shift+["], reserved: true, when: () => router.tabs().length > 1, run: () => router.cycle(-1), menu: { name: "window", group: 0.2 } });
for (let i = 1; i <= 9; i++) {
  const last = i === 9;
  defineAction({ id: `tabs.go${i}`, title: last ? "Last tab" : `Tab ${i}`, keys: [`Mod+${i}`], reserved: true, palette: false, when: () => router.tabs().length >= (last ? 1 : i), run: () => router.select(last ? -1 : i - 1), menu: { name: "window", group: 1 } });
}

// ---- Help -------------------------------------------------------------------------------------
defineAction({ id: "app.shortcuts", title: "Keyboard shortcuts", keys: ["Mod+/"], reserved: true, run: openShortcuts, menu: { name: "help", group: 0 }, icon: Keyboard });
defineAction({ id: "app.revealLogs", title: "Reveal logs", run: revealLogs, menu: { name: "help", group: 1 } });
