/** Tabs, as in Obsidian: each with its own history; opened, closed, reopened, moved and kept. */
import { describe, expect, it } from "vitest";
import { mock, seed } from "./mock/backend";
import { createShell, type Shell } from "../src/shell/shell";
import { Router } from "../src/shell/router";
import { notes } from "../src/features/notes";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
let last: Shell | null = null;

async function boot() {
  last?.destroy();
  mock.reset();
  mock.state.folder = "/lib";
  const a = seed("note", "Gravity and grace", "See [[Waiting for God|0192f3a4-7c1e-7b2a-9f00-000000000002]].\n");
  const b = seed("note", "Waiting for God", "Text.\n");
  document.body.innerHTML = '<div id="app"></div>';
  const shell = createShell(document.getElementById("app")!, [notes]);
  last = shell;
  await wait(60);
  return { shell, a, b };
}

const tabs = () => [...document.querySelectorAll<HTMLElement>(".tab-bar [role=tab]")];
const titles = () => tabs().map((t) => t.querySelector(".tab-title")?.textContent);
const press = (key: string, code: string, mods: KeyboardEventInit = {}) => document.body.dispatchEvent(new KeyboardEvent("keydown", { key, code, bubbles: true, cancelable: true, ...mods }));

describe("the router's tabs", () => {
  it("keep their own history, close to their neighbour, reopen with theirs, and move", () => {
    const r = new Router();
    r.go("notes");
    r.go("note", { id: "a" });
    r.newTab({ page: "note", params: { id: "b" } });
    expect(r.tabs().map((t) => t.route.params.id ?? t.route.page)).toEqual(["a", "b"]);
    expect(r.canBack()).toBe(false);
    r.select(0);
    expect(r.current().params.id).toBe("a");
    r.back();
    expect(r.current().page).toBe("notes");
    r.forward();
    r.go("note", { id: "c" }, { newTab: true, background: true });
    expect(r.current().params.id).toBe("a");
    expect(r.tabs()).toHaveLength(3);
    r.close();
    expect(r.current().params.id).toBe("c");
    expect(r.reopen()).toBe(true);
    expect(r.current().params.id).toBe("a");
    r.back();
    expect(r.current().page).toBe("notes");
    r.move(r.active(), 2);
    expect(r.tabs()[2]!.id).toBe(r.active());
    // Closing the last tab leaves a new one.
    r.closeOthers();
    r.close();
    expect(r.tabs()).toHaveLength(1);
    expect(r.current().page).toBe("newtab");
    // Kept and brought back.
    r.go("note", { id: "z" });
    r.newTab();
    const saved = JSON.parse(JSON.stringify(r.save()));
    const again = new Router();
    expect(again.restore(saved)).toBe(true);
    expect(again.tabs().map((t) => t.route.page)).toEqual(["note", "newtab"]);
    expect(again.current().page).toBe("newtab");
    again.select(0);
    again.back();
    expect(again.current().page).toBe("newtab");
  });
});

describe("tabs in the window", () => {
  it("⌘T opens a new tab, ⌃Tab and ⌘1 switch, ⌘W closes, ⇧⌘T reopens; titles follow the page", async () => {
    const { shell, a } = await boot();
    shell.openRecord(a.id);
    await wait(30);
    expect(titles()).toEqual(["Gravity and grace"]);
    press("t", "KeyT", { metaKey: true });
    await wait(20);
    expect(titles()).toEqual(["Gravity and grace", "New tab"]);
    expect(tabs()[1]!.getAttribute("aria-selected")).toBe("true");
    expect(document.querySelector(".ws-page:not([hidden])")?.textContent).toContain("Opened recently");
    press("Tab", "Tab", { ctrlKey: true });
    await wait(20);
    expect(shell.router.current().params.id).toBe(a.id);
    press("2", "Digit2", { metaKey: true });
    await wait(20);
    expect(shell.router.current().page).toBe("newtab");
    press("w", "KeyW", { metaKey: true });
    await wait(20);
    expect(titles()).toEqual(["Gravity and grace"]);
    press("t", "KeyT", { metaKey: true, shiftKey: true });
    await wait(20);
    expect(titles()).toEqual(["Gravity and grace", "New tab"]);
  });

  it("opens records in a new tab from their menu and with a middle-click, and closes a tab with a middle-click", async () => {
    const { shell, b } = await boot();
    const row = [...document.querySelectorAll<HTMLElement>(".tree [role=treeitem]")].find((x) => x.textContent === "Waiting for God")!;
    row.dispatchEvent(new MouseEvent("auxclick", { button: 1, bubbles: true }));
    await wait(30);
    expect(shell.router.tabs()).toHaveLength(2);
    expect(shell.router.current().params.id).toBe(b.id);
    tabs()[1]!.dispatchEvent(new MouseEvent("auxclick", { button: 1, bubbles: true }));
    await wait(20);
    expect(shell.router.tabs()).toHaveLength(1);
    shell.showRecordMenu(shell.records.get(b.id)!, { x: 10, y: 10 });
    ([...document.querySelectorAll(".context-menu [role=menuitem]")].find((m) => m.textContent === "Open in new tab") as HTMLElement).click();
    await wait(30);
    expect(shell.router.tabs()).toHaveLength(2);
  });

  it("keep their pages alive while another tab shows, and keep their scroll", async () => {
    const { shell, a } = await boot();
    shell.openRecord(a.id);
    await wait(40);
    const page = document.querySelector(".ws-page:not([hidden])")!;
    const scroller = document.querySelector<HTMLElement>(".page-scroll")!;
    scroller.scrollTop = 120;
    shell.router.newTab();
    await wait(20);
    expect((page as HTMLElement).hidden).toBe(true);
    shell.router.select(0);
    await wait(20);
    expect(document.querySelector(".ws-page:not([hidden])")).toBe(page);
    expect(scroller.scrollTop).toBe(120);
    expect(document.querySelectorAll(".ws-page")).toHaveLength(2);
    shell.router.close(shell.router.tabs()[1]!.id);
    await wait(20);
    expect(document.querySelectorAll(".ws-page")).toHaveLength(1);
  });

  it("are kept for next time", async () => {
    const { shell, a, b } = await boot();
    shell.openRecord(a.id);
    shell.openRecord(b.id, {}, { newTab: true });
    await wait(700);
    const saved = mock.state.settings["ui.tabs"] as { tabs: unknown[]; active: number } | undefined;
    expect(saved?.tabs).toHaveLength(2);
    expect(saved?.active).toBe(1);
  });
});
