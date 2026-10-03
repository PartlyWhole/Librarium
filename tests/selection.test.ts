/** Selecting several records (sidebar, Library) and acting on them; removing snapshots. */
import { describe, expect, it } from "vitest";
import { mock, seed } from "./mock/backend";
import { createShell, type Shell } from "../src/shell/shell";
import { notes } from "../src/features/notes";
import { library } from "../src/features/library";
import { archive } from "../src/features/archive";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
let last: Shell | null = null;

async function boot() {
  last?.destroy();
  mock.reset();
  mock.state.folder = "/lib";
  const n = ["Alpha", "Beta", "Gamma", "Delta"].map((t) => seed("note", t, "Text.\n"));
  const snaps = (n: number) => Array.from({ length: n }, (_, i) => ({ at: `2026-10-0${i + 1}T090000Z`, checks: [] }));
  const pages = [seed("item", "Essay one", "", { "library.format": "web", "library.snapshots": snaps(3), "library.snapshot": "2026-10-03T090000Z" }), seed("item", "Essay two", "", { "library.format": "web", "library.snapshots": snaps(2), "library.snapshot": "2026-10-02T090000Z" }), seed("item", "A book", "", { "library.format": "pdf" })];
  document.body.innerHTML = '<div id="app"></div>';
  const shell = createShell(document.getElementById("app")!, [notes, library, archive]);
  last = shell;
  await wait(50);
  return { shell, n, pages };
}

const row = (title: string) => [...document.querySelectorAll(".tree [role=treeitem]")].find((x) => x.querySelector(".tree-label")?.textContent === title) as HTMLElement;
const click = (el: Element, mods: MouseEventInit = {}) => el.dispatchEvent(new MouseEvent("click", { bubbles: true, ...mods }));
const menu = () => [...document.querySelectorAll(".context-menu [role=menuitem]")].map((b) => b.textContent);
const choose = (label: string) => ([...document.querySelectorAll(".context-menu [role=menuitem]")].find((b) => b.textContent === label) as HTMLElement).click();
const selected = () => [...document.querySelectorAll(".tree [aria-selected=true] .tree-label")].map((x) => x.textContent);

describe("several records at once", () => {
  it("are selected in the sidebar with ⌘-click and ⇧-click, and archived together with one Undo", async () => {
    const { shell } = await boot();
    click(row("Alpha"));
    await wait(10);
    expect(shell.router.current().params.id).toBeDefined(); // a plain click opens
    click(row("Delta"), { metaKey: true });
    expect(selected().sort()).toEqual(["Alpha", "Delta"]);
    click(row("Beta"), { shiftKey: true });
    expect(selected().length).toBeGreaterThanOrEqual(2);
    // Right-click on a selected row acts on the whole selection.
    click(row("Alpha"));
    click(row("Gamma"), { metaKey: true });
    row("Gamma").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
    expect(menu()).toEqual(["Archive 2 items"]);
    choose("Archive 2 items");
    await wait(40);
    expect(shell.records.list("note").map((r) => r.title).sort()).toEqual(["Beta", "Delta"]);
    await shell.undo.undoLast();
    await wait(20);
    expect(shell.records.list("note")).toHaveLength(4);
  });

  it("extend with ⇧↓ from the keyboard, and Escape leaves one", async () => {
    await boot();
    click(row("Alpha"));
    row("Alpha").focus();
    row("Alpha").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", shiftKey: true, bubbles: true }));
    expect(selected().length).toBe(2);
    (document.activeElement as HTMLElement).dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(selected().length).toBe(1);
  });

  it("on the Library page: ⌘A, then remove older snapshots of every page, after confirming", async () => {
    const { shell, pages } = await boot();
    shell.router.go("library");
    await wait(30);
    const opts = () => [...document.querySelectorAll(".item-list [role=option]")] as HTMLElement[];
    const essays = opts().filter((o) => o.textContent?.includes("Essay"));
    expect(essays[0]!.textContent).toContain("3 snapshots");
    essays[0]!.focus();
    essays[0]!.dispatchEvent(new KeyboardEvent("keydown", { key: "a", metaKey: true, bubbles: true }));
    expect(opts().every((o) => o.getAttribute("aria-selected") === "true")).toBe(true);
    // With everything selected, the snapshot action counts only the pages that have older ones.
    essays[0]!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
    expect(menu()).toEqual(["Archive 3 items", "Remove older snapshots of 2 pages…"]);
    document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    // ⌘A turned select mode on; leave it, so a click opens and selects one again.
    [...document.querySelectorAll(".select-bar button")].find((b) => b.textContent === "Done")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await wait(10);
    // Just the two essays.
    click(essays[0]!);
    click(essays[1]!, { metaKey: true });
    essays[1]!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
    expect(menu()).toContain("Remove older snapshots of 2 pages…");
    choose("Remove older snapshots of 2 pages…");
    await wait(30);
    let dialog = document.querySelector("dialog")!;
    expect(dialog.textContent).toContain("Remove 3 snapshots from 2 pages?");
    expect(document.activeElement?.textContent).toBe("Cancel");
    [...dialog.querySelectorAll("button")].find((b) => b.textContent === "Cancel")!.click();
    await wait(30);
    expect(mock.state.calls.some((c) => c.method === "library.removeSnapshots")).toBe(false);
    essays[1]!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
    choose("Remove older snapshots of 2 pages…");
    await wait(30);
    dialog = document.querySelector("dialog")!;
    [...dialog.querySelectorAll("button")].find((b) => b.textContent === "Remove snapshots")!.click();
    await wait(40);
    expect((shell.records.get(pages[0]!.id)!.fields["library.snapshots"] as unknown[]).length).toBe(1);
    expect((shell.records.get(pages[1]!.id)!.fields["library.snapshots"] as unknown[]).length).toBe(1);
    expect(shell.records.get(pages[0]!.id)!.fields["library.snapshot"]).toBe("2026-10-03T090000Z");
  });
});

describe("select mode", () => {
  it("on the Library page: Select, click to tick (not open), act from the bar, Done", async () => {
    const { shell } = await boot();
    shell.router.go("library");
    await wait(30);
    const bar = () => document.querySelector(".select-bar")!;
    const opts = () => [...document.querySelectorAll(".item-list [role=option]")] as HTMLElement[];
    (bar().querySelector("button") as HTMLButtonElement).click();
    await wait(10);
    expect(document.querySelector(".item-list")!.classList.contains("selecting")).toBe(true);
    click(opts()[0]!);
    click(opts()[1]!);
    await wait(10);
    expect(shell.router.current().page).toBe("library"); // ticking doesn't open
    expect(bar().textContent).toContain("2 items selected");
    expect([...bar().querySelectorAll("button")].map((b) => b.textContent)).toContain("Archive 2 items");
    [...bar().querySelectorAll("button")].find((b) => b.textContent === "Done")!.click();
    await wait(10);
    expect(document.querySelector(".item-list")!.classList.contains("selecting")).toBe(false);
    expect(opts().some((o) => o.getAttribute("aria-selected") === "true")).toBe(false);
  });

  it("⌘A anywhere on the Archive page selects every record, and they can be deleted after confirming", async () => {
    const { shell, n } = await boot();
    for (const r of n) await (await import("./mock/backend")).call("archive.archive", { id: r.id });
    await shell.records.load();
    shell.router.go("archive");
    await wait(30);
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "a", metaKey: true, bubbles: true }));
    await wait(10);
    const bar = document.querySelector(".select-bar")!;
    expect(bar.textContent).toContain("4 records selected");
    const del = [...bar.querySelectorAll("button")].find((b) => b.textContent === "Delete 4 items permanently…")!;
    expect(del).toBeDefined();
    del.click();
    await wait(30);
    const dialog = document.querySelector("dialog")!;
    expect(dialog.textContent).toContain("Delete 4 records permanently?");
    [...dialog.querySelectorAll("button")].find((b) => b.textContent === "Cancel")!.click();
    await wait(20);
    expect(mock.state.deleted).toEqual([]);
    // Escape leaves select mode.
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await wait(10);
    expect(document.querySelector(".select-bar")!.textContent).toBe("Select");
  });
});

describe("failed jobs", () => {
  it("are a button in the status bar that opens the Jobs view, saying which page and why, and can be dismissed", async () => {
    const { shell } = await boot();
    const job = (i: number) => ({ id: `0192f3a4-7c1e-7b2a-9f00-0000000001${i}0`, kind: "library.savePage", key: `https://x.example/${i}`, state: "failed", title: "Saving a web page", attempts: 1, error: "the page didn’t finish loading in 90 s", progress: null, message: null, payload: { url: `https://x.example/${i}` }, created_ms: 0, updated_ms: 0 });
    mock.state.jobs = [job(1), job(2)];
    mock.emit("event.job", job(1));
    await wait(600);
    const status = document.querySelector(".status-jobs button") as HTMLButtonElement;
    expect(status.textContent).toBe("2 failed");
    status.click();
    await wait(50);
    const panel = document.querySelector('.side-panel [data-section="jobs"]')!;
    expect(panel.textContent).toContain("https://x.example/1");
    expect(panel.textContent).toContain("Why: the page didn’t finish loading in 90 s");
    [...panel.querySelectorAll("button")].find((b) => b.textContent === "Dismiss all")!.click();
    await wait(50);
    expect(document.querySelector(".status-jobs")!.textContent).toBe("");
    void shell;
  });
});
