/** The shell, in jsdom, against the mock backend. */
import { beforeEach, describe, expect, it } from "vitest";
import axe from "axe-core";
import { mock, seed } from "./mock/backend";
import { createShell, type Shell } from "../src/shell/shell";
import { menuSpec } from "../src/shell/menu";
import { notes } from "../src/features/notes";
import { daily } from "../src/features/daily";
import { library } from "../src/features/library";
import { search } from "../src/features/search";
import { archive } from "../src/features/archive";
import { Actions, ShortcutCollision } from "../src/shell/actions";
import { DuplicateError } from "../src/kit/registry";

const FEATURES = [notes, daily, library, search, archive];

async function settle(ms = 20) {
  await new Promise((r) => setTimeout(r, ms));
}

let last: Shell | null = null;

async function boot(open = true): Promise<Shell> {
  last?.destroy();
  mock.reset();
  if (open) {
    mock.state.folder = "/lib";
    seed("note", "Jacques Ellul", "Body", {}, "Thinkers");
    seed("note", "2026-10-02", "Day", { "daily.date": "2026-10-02" });
    seed("item", "An essay");
  }
  document.body.innerHTML = '<div id="app"></div>';
  const shell = createShell(document.getElementById("app")!, FEATURES);
  last = shell;
  await settle(50);
  return shell;
}

function key(k: string, code: string, mods: Partial<KeyboardEventInit> = {}, target: EventTarget = document.body) {
  const e = new KeyboardEvent("keydown", { key: k, code, bubbles: true, cancelable: true, ...mods });
  target.dispatchEvent(e);
  return e;
}

beforeEach(() => {
  document.querySelectorAll("dialog").forEach((d) => d.remove());
});

describe("registries", () => {
  it("reject duplicate IDs and shortcut collisions", () => {
    const a = new Actions();
    a.add("t", { id: "x", title: "X", keys: ["Mod+K"], run: () => {} });
    expect(() => a.add("t", { id: "x", title: "X again", run: () => {} })).toThrow(DuplicateError);
    expect(() => a.add("t", { id: "y", title: "Y", keys: ["mod+k"], run: () => {} })).toThrow(ShortcutCollision);
  });

  it("refuse a feature that reuses a page ID", async () => {
    mock.reset();
    document.body.innerHTML = '<div id="app"></div>';
    expect(() => createShell(document.getElementById("app")!, [notes, notes])).toThrow(DuplicateError);
  });
});

describe("layout", () => {
  it("has the five regions and opens today's note", async () => {
    const shell = await boot();
    expect(document.querySelector(".ribbon")).toBeTruthy();
    expect(document.querySelector(".app-sidebar")).toBeTruthy();
    expect(document.querySelector(".ws-header")).toBeTruthy();
    expect((document.querySelector(".side-panel") as HTMLElement).hidden).toBe(true);
    expect(document.querySelector(".status-bar")).toBeTruthy();
    const ribbon = [...document.querySelectorAll(".ribbon .icon-button")].map((b) => b.getAttribute("aria-label"));
    expect(ribbon).toEqual(["Toggle sidebar", "Today", "Notes", "Library", "Search", "Archive", "Command palette", "Keyboard shortcuts", "Settings"]);
    expect(shell.router.current().page).toBe("note");
    expect(shell.records.get(shell.router.current().params.id!)?.fields["daily.date"]).toBe("2026-10-02");
  });

  it("shows the welcome page on first run, with no silent default", async () => {
    await boot(false);
    expect(document.querySelector(".page-title")?.textContent).toBe("Welcome to Librarium");
    expect(mock.state.calls.some((c) => c.method === "folder.open")).toBe(false);
  });

  it("lists notes by folder, daily notes among them at the top level (no group of their own)", async () => {
    await boot();
    const rows = [...document.querySelectorAll(".tree [role=treeitem]")].map((r) => `${r.getAttribute("aria-level")} ${r.textContent}`);
    expect(rows).not.toContain("2 Daily notes");
    expect(rows).toContain("2 Thinkers");
    expect(rows).toContain("3 Jacques Ellul");
    expect(rows.some((r) => /^2 \d{4}-\d{2}-\d{2}$/.test(r))).toBe(true);
  });

  it("every icon button has a spoken label and a tooltip", async () => {
    await boot();
    for (const b of document.querySelectorAll(".icon-button")) {
      expect(b.getAttribute("aria-label")).toBeTruthy();
      expect(b.getAttribute("title")).toBeTruthy();
    }
    expect(document.querySelector('[aria-label="Search"]')?.getAttribute("title")).toBe("Search (⇧⌘F)");
  });
});

describe("actions are reachable", () => {
  it("from the palette, the menu and the keyboard", async () => {
    const shell = await boot();
    const spec = menuSpec(shell.actions);
    const inMenu = new Set(spec.flatMap((s) => s.entries).flatMap((e) => (e.kind === "item" ? [e.id] : [])));
    for (const a of shell.actions.all()) {
      expect(inMenu.has(a.id), `${a.id} is in the menu`).toBe(true);
      expect(a.palette !== false || (a.keys?.length ?? 0) > 0, `${a.id} is in the palette or has a key`).toBe(true);
    }
  });

  it("the menu has the App, Edit, Window and Help menus", async () => {
    const shell = await boot();
    const spec = menuSpec(shell.actions);
    const titles = spec.map((s) => s.title);
    expect(titles[0]).toBe("Librarium");
    for (const t of ["Edit", "Window", "Help"]) expect(titles).toContain(t);
    const edit = spec.find((s) => s.title === "Edit")!.entries.flatMap((e) => (e.kind === "predefined" ? [e.item] : []));
    expect(edit).toEqual(expect.arrayContaining(["Undo", "Redo", "Cut", "Copy", "Paste", "SelectAll"]));
    const app = spec[0]!.entries;
    expect(app.some((e) => e.kind === "item" && e.text === "Settings…" && e.accelerator === "CmdOrCtrl+,")).toBe(true);
    expect(app.some((e) => e.kind === "predefined" && e.item === "Quit")).toBe(true);
  });

  it("the documented shortcuts run their actions", async () => {
    const shell = await boot();
    key("p", "KeyP", { metaKey: true, shiftKey: true });
    expect(document.querySelector("dialog [role=combobox]")).toBeTruthy();
    document.querySelector("dialog")!.remove();
    key("f", "KeyF", { metaKey: true, shiftKey: true });
    await settle();
    expect(shell.router.current().page).toBe("search");
    key("ArrowLeft", "ArrowLeft", { metaKey: true, altKey: true });
    expect(shell.router.current().page).toBe("note");
    key("ArrowRight", "ArrowRight", { metaKey: true, altKey: true });
    expect(shell.router.current().page).toBe("search");
    key("\\", "Backslash", { metaKey: true });
    await settle();
    expect((document.querySelector(".app-sidebar") as HTMLElement).hidden).toBe(true);
    key("«", "Backslash", { metaKey: true, altKey: true });
    await settle();
    expect((document.querySelector(".side-panel") as HTMLElement).hidden).toBe(false);
    key(",", "Comma", { metaKey: true });
    expect(shell.router.current().page).toBe("settings");
    key("/", "Slash", { metaKey: true });
    expect(document.querySelector("dialog")?.getAttribute("aria-label")).toBe("Keyboard shortcuts");
  });

  it("key handlers ignore IME composition", async () => {
    const shell = await boot();
    key("f", "KeyF", { metaKey: true, shiftKey: true, isComposing: true });
    expect(shell.router.current().page).toBe("note");
  });

  it("the editor keeps non-reserved keys, but not the app's reserved shortcuts", async () => {
    const shell = await boot();
    let ran = false;
    shell.actions.add("test", { id: "test.plain", title: "Plain", keys: ["Mod+J"], run: () => void (ran = true) });
    const ed = document.createElement("div");
    ed.className = "cm-editor";
    document.body.appendChild(ed);
    key("j", "KeyJ", { metaKey: true }, ed);
    expect(ran).toBe(false);
    key("f", "KeyF", { metaKey: true, shiftKey: true }, ed);
    expect(shell.router.current().page).toBe("search");
  });
});

describe("the palette", () => {
  it("follows the combobox pattern and opens in under 50 ms", async () => {
    const shell = await boot();
    for (let i = 0; i < 300; i++) shell.actions.add("test", { id: `test.${i}`, title: `Test action number ${i}`, run: () => {} });
    const t = performance.now();
    shell.actions.run("shell.palette");
    const ms = performance.now() - t;
    expect(ms).toBeLessThan(50);
    const input = document.querySelector("dialog [role=combobox]") as HTMLInputElement;
    const list = document.getElementById(input.getAttribute("aria-controls")!)!;
    expect(list.getAttribute("role")).toBe("listbox");
    expect(input.getAttribute("aria-activedescendant")).toBe(list.firstElementChild!.id);
    input.value = "toggle side";
    input.dispatchEvent(new Event("input"));
    expect(list.firstElementChild!.textContent).toContain("Toggle sidebar");
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown" }));
    expect(input.getAttribute("aria-activedescendant")).toBe(list.children[1]!.id);
    expect(list.children[1]!.getAttribute("aria-selected")).toBe("true");
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    await settle();
    expect(document.querySelector("dialog")).toBeNull();
    expect((document.querySelector(".side-panel") as HTMLElement).hidden).toBe(false);
  });

  it("⌘O opens a record by title", async () => {
    const shell = await boot();
    key("o", "KeyO", { metaKey: true });
    const input = document.querySelector("dialog [role=combobox]") as HTMLInputElement;
    input.value = "ellul";
    input.dispatchEvent(new Event("input"));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    expect(shell.router.current().page).toBe("note");
  });
});

describe("the sidebar tree", () => {
  it("has one tab stop and moves with the arrow keys", async () => {
    await boot();
    const items = () => [...document.querySelectorAll<HTMLElement>("[role=treeitem]")];
    expect(items().filter((i) => i.tabIndex === 0)).toHaveLength(1);
    expect(document.querySelectorAll("[role=tree] button")).toHaveLength(0);
    const first = items().find((i) => i.tabIndex === 0)!;
    first.focus();
    first.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect((document.activeElement as HTMLElement).dataset.index).toBe("1");
    expect(items().filter((i) => i.tabIndex === 0)).toHaveLength(1);
    const notesSection = items()[0]!;
    expect(notesSection.getAttribute("aria-expanded")).toBe("true");
    notesSection.focus();
    notesSection.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
    await settle();
    expect(items()[0]!.getAttribute("aria-expanded")).toBe("false");
    expect(mock.state.settings["ui.folded"] ?? []).toEqual([]);
    await settle(400);
    expect(mock.state.settings["ui.folded"]).toEqual(["section:notes"]);
  });
});

describe("preferences", () => {
  it("are saved by the backend, not in WebKit storage", async () => {
    const shell = await boot();
    shell.prefs.pref("ui.theme", "system").set("dark");
    await settle(400);
    expect(mock.state.settings["ui.theme"]).toBe("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(localStorage.length).toBe(0);
  });
});

describe("accessibility", () => {
  it("passes an axe check", async () => {
    await boot();
    const r = await axe.run(document.body, { rules: { "color-contrast": { enabled: false } } });
    expect(r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target).join(", ")}`)).toEqual([]);
  });

  it("passes an axe check with the palette open", async () => {
    const shell = await boot();
    shell.actions.run("shell.palette");
    const r = await axe.run(document.body, { rules: { "color-contrast": { enabled: false } } });
    expect(r.violations.map((v) => v.id)).toEqual([]);
  });
});
