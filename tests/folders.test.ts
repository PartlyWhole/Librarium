/** Folders: notes and library items each have their own, browsed and organised as in Finder. */
import { describe, expect, it } from "vitest";
import { mock, seed } from "./mock/backend";
import { createShell, type Shell } from "../src/shell/shell";
import { notes } from "../src/features/notes";
import { library } from "../src/features/library";
import { archive } from "../src/features/archive";
import { captures } from "../src/features/captures";
import { daily } from "../src/features/daily";
import { Contents, folderOf, placed, sortEntries, uniqueName, type Entry } from "../src/shell/folders/model";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
let last: Shell | null = null;

async function boot() {
  last?.destroy();
  mock.reset();
  mock.state.folder = "/Users/me/Reading room";
  const ellul = seed("note", "Jacques Ellul", "", {}, "Thinkers");
  const weil = seed("note", "Simone Weil", "", {}, "Thinkers/French");
  const list = seed("note", "Reading list");
  const book = seed("item", "The Technological Society", "", { "library.format": "pdf", "library.pages": 12 });
  const page = seed("item", "On attention", "", { "library.format": "web", provenance: { source: "https://www.example.org/attention" } }, "Thinkers");
  mock.state.folders.add("note:Empty");
  document.body.innerHTML = '<div id="app"></div>';
  const shell = createShell(document.getElementById("app")!, [notes, library, captures, archive]);
  last = shell;
  await wait(60);
  return { shell, ellul, weil, list, book, page };
}

const rows = () => [...document.querySelectorAll<HTMLElement>(".files-body [role=option]")];
const names = () => rows().map((r) => r.querySelector(".files-name-text")?.textContent ?? "");
const row = (name: string) => rows().find((r) => r.querySelector(".files-name-text")?.textContent === name)!;
const key = (el: Element, k: string, o: KeyboardEventInit = {}) => el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...o }));
const methods = () => mock.state.calls.map((c) => c.method);

/**
 * A pointer drag of `from` released over `to`: on its top edge, middle or bottom edge (jsdom has
 * no layout: the hit test and the target's box are stubbed). Returns the mark shown.
 */
function drag(from: HTMLElement, to: HTMLElement, where: "before" | "into" | "after" = "into") {
  const y = { before: 1, into: 10, after: 19 }[where];
  document.elementFromPoint = () => to;
  to.getBoundingClientRect = () => ({ top: 0, left: 0, width: 100, height: 20, right: 100, bottom: 20, x: 0, y: 0, toJSON: () => ({}) });
  from.dispatchEvent(new PointerEvent("pointerdown", { clientX: 50, clientY: 50, bubbles: true, button: 0 }));
  window.dispatchEvent(new PointerEvent("pointermove", { clientX: 50, clientY: y, bubbles: true }));
  const mark = ["drop-over", "drop-before", "drop-after"].find((c) => to.classList.contains(c)) ?? null;
  window.dispatchEvent(new PointerEvent("pointerup", { clientX: 50, clientY: y, bubbles: true }));
  return mark;
}

describe("the folder model", () => {
  it("reads a record's folder from its path, for notes and folder records alike", async () => {
    const { ellul, weil, book, page } = await boot();
    expect(folderOf(ellul)).toBe("Thinkers");
    expect(folderOf(weil)).toBe("Thinkers/French");
    expect(folderOf(book)).toBe("");
    expect(folderOf(page)).toBe("Thinkers");
  });

  it("hides a folder whose records are all hidden, and keeps an empty one", async () => {
    const { weil, ellul } = await boot();
    const hidden = (r: { id: string }) => r.id === weil.id;
    const c = new Contents(["Empty"], [weil, ellul], hidden);
    expect(c.folders).toEqual(["Empty", "Thinkers"]);
    expect(c.entries("Thinkers").map((e) => e.name)).toEqual(["Jacques Ellul"]);
  });

  it("sorts folders first, names as people read them, and names new folders as Finder does", () => {
    const e = (name: string, type: "folder" | "record" = "record"): Entry => (type === "folder" ? { type, id: name, path: name, name, count: 0 } : { type, id: name, name, record: { created: null } as never });
    const sorted = sortEntries([e("Item 10"), e("Zeta", "folder"), e("item 9"), e("Alpha", "folder")], { key: "name", dir: 1 }, () => "");
    expect(sorted.map((x) => x.name)).toEqual(["Alpha", "Zeta", "item 9", "Item 10"]);
    const desc = sortEntries([e("a"), e("b"), e("F", "folder")], { key: "name", dir: -1 }, () => "");
    expect(desc.map((x) => x.name)).toEqual(["F", "b", "a"]);
    expect(uniqueName("untitled folder", (n) => ["untitled folder", "untitled folder 2"].includes(n))).toBe("untitled folder 3");
    // As arranged: listed first, in that order (folders anywhere), then the rest as usual.
    const manual = sortEntries([e("b"), e("Zeta", "folder"), e("a"), e("c")], { key: "manual", dir: 1 }, () => "", ["c", "folder:Zeta"]);
    expect(manual.map((x) => x.name)).toEqual(["c", "Zeta", "a", "b"]);
  });

  it("places things before or after another, keeping their order", () => {
    expect(placed(["a", "b", "c", "d"], ["d"], "a", "before")).toEqual(["d", "a", "b", "c"]);
    expect(placed(["a", "b", "c", "d"], ["a", "c"], "d", "after")).toEqual(["b", "d", "a", "c"]);
    expect(placed(["a", "b"], ["a"], "a", "after")).toEqual(["a", "b"]);
    expect(placed(["a", "b"], ["x"], "a", "after")).toEqual(["a", "x", "b"]);
  });
});

describe("the Notes and Library pages", () => {
  it("each show their own folders first, then their records, with kinds; a double-click opens a folder", async () => {
    const { shell } = await boot();
    shell.router.go("notes", {});
    await wait(30);
    expect(names()).toEqual(["Empty", "Thinkers", "Reading list"]);
    expect(row("Thinkers").textContent).toContain("Folder · 2 items");
    expect(document.querySelector(".files-crumbs")?.textContent).toBe("Notes");
    expect(document.querySelector(".files-count")?.textContent).toBe("2 folders, 1 item");
    row("Thinkers").dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    await wait(30);
    expect(shell.router.current()).toEqual({ page: "notes", params: { folder: "Thinkers" } });
    expect(names()).toEqual(["French", "Jacques Ellul"]);
    expect([...document.querySelectorAll(".crumb")].map((c) => c.textContent)).toEqual(["Notes", "Thinkers"]);
    expect(shell.here()).toEqual({ kind: "note", folder: "Thinkers" });
    // The Library has its own "Thinkers", holding only library items.
    shell.router.go("library", {});
    await wait(30);
    expect(names()).toEqual(["Thinkers", "The Technological Society"]);
    expect(row("The Technological Society").textContent).toContain("PDF");
    expect(row("The Technological Society").textContent).toContain("12 pages");
    row("Thinkers").dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    await wait(30);
    expect(names()).toEqual(["On attention"]);
  });

  it("selects with clicks (⌘ and ⇧ for several) and opens with Return; ⌘↑ goes up to where one was", async () => {
    const { shell, list } = await boot();
    shell.router.go("notes", {});
    await wait(30);
    row("Empty").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    row("Reading list").dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: true }));
    expect(rows().filter((r) => r.classList.contains("selected"))).toHaveLength(3);
    row("Thinkers").dispatchEvent(new MouseEvent("click", { bubbles: true, metaKey: true }));
    expect(document.querySelector(".files-count")?.textContent).toContain("2 selected");
    // A plain click selects only; it never opens.
    row("Reading list").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(shell.router.current().page).toBe("notes");
    key(row("Reading list"), "Enter");
    await wait(30);
    expect(shell.router.current()).toEqual({ page: "note", params: { id: list.id } });
    shell.router.go("notes", { folder: "Thinkers/French" });
    await wait(30);
    key(rows()[0]!, "ArrowUp", { metaKey: true });
    await wait(30);
    expect(shell.router.current().params.folder).toBe("Thinkers");
    expect(document.activeElement?.textContent).toContain("French");
  });

  it("moves what is dragged onto a folder or the sidebar, and undoes it; never across kinds", async () => {
    const { shell, ellul, list } = await boot();
    shell.router.go("notes", {});
    await wait(30);
    expect(drag(row("Reading list"), row("Thinkers"))).toBe("drop-over");
    await wait(30);
    expect(names()).toEqual(["Empty", "Thinkers"]);
    expect(folderOf(shell.records.get(list.id)!)).toBe("Thinkers");
    await shell.undo.undoLast();
    await wait(30);
    expect(folderOf(shell.records.get(list.id)!)).toBe("");
    // Redo moves it there again; Undo takes it back again.
    await shell.undo.redoLast();
    await wait(30);
    expect(folderOf(shell.records.get(list.id)!)).toBe("Thinkers");
    await shell.undo.undoLast();
    await wait(30);
    expect(folderOf(shell.records.get(list.id)!)).toBe("");
    // A folder into a folder; never into itself.
    expect(drag(row("Thinkers"), row("Thinkers"))).toBeNull();
    expect(drag(row("Thinkers"), row("Empty"))).toBe("drop-over");
    await wait(30);
    expect(folderOf(shell.records.get(ellul.id)!)).toBe("Empty/Thinkers");
    expect(methods()).toContain("folders.move");
    // Onto a folder in the sidebar's tree.
    const tree = () => [...document.querySelectorAll<HTMLElement>(".tree [role=treeitem]")];
    expect(drag(row("Reading list"), tree().find((t) => t.textContent === "Empty")!)).toBe("drop-over");
    await wait(30);
    expect(folderOf(shell.records.get(list.id)!)).toBe("Empty");
    // A library item isn't taken by a notes folder.
    shell.router.go("library", {});
    await wait(30);
    expect(drag(row("The Technological Society"), tree().find((t) => t.textContent === "Empty")!)).toBeNull();
  });

  it("makes a folder named in place, renames with F2, and removes only an empty one", async () => {
    const { shell } = await boot();
    shell.router.go("library", {});
    await wait(30);
    shell.actions.run("folders.newFolder");
    await wait(30);
    const input = document.querySelector<HTMLInputElement>(".files-rename")!;
    expect(input.value).toBe("untitled folder");
    input.value = "Plato";
    key(input, "Enter");
    await wait(30);
    expect(names()).toContain("Plato");
    expect(mock.state.folders.has("item:Plato")).toBe(true);
    expect(mock.state.folders.has("note:Plato")).toBe(false);
    row("Plato").focus();
    key(row("Plato"), "F2");
    const again = document.querySelector<HTMLInputElement>(".files-rename")!;
    again.value = "Platonists";
    key(again, "Enter");
    await wait(30);
    expect(names()).toContain("Platonists");
    expect(mock.state.folders.has("item:Plato")).toBe(false);
    const { call } = await import("./mock/backend");
    await expect(call("folders.remove", { kind: "item", path: "Thinkers" })).rejects.toThrow(/isn’t empty/);
  });

  it("filters the folder, and switches to icons", async () => {
    const { shell } = await boot();
    shell.router.go("library", { folder: "Thinkers" });
    await wait(30);
    shell.router.go("library", {});
    await wait(30);
    const filter = document.querySelector<HTMLInputElement>(".files-filter")!;
    filter.value = "techno";
    filter.dispatchEvent(new Event("input"));
    await wait(10);
    expect(names()).toEqual(["The Technological Society"]);
    shell.prefs.pref("folders.view.item", "list").set("icons");
    await wait(10);
    expect(document.querySelector(".files-body")?.classList.contains("icons")).toBe(true);
  });

  it("hides archived records, and a folder holding only archived ones", async () => {
    const { shell, weil } = await boot();
    shell.router.go("notes", { folder: "Thinkers" });
    await wait(30);
    expect(names()).toContain("French");
    const { call } = await import("./mock/backend");
    await call("archive.archive", { id: weil.id });
    await wait(30);
    expect(names()).not.toContain("French");
  });

  it("puts new notes into the notes folder being looked at, and offers Move to folder… in records' menus", async () => {
    const { shell, list } = await boot();
    shell.router.go("notes", { folder: "Thinkers/French" });
    await wait(30);
    shell.actions.run("notes.new");
    await wait(30);
    const created = mock.state.calls.filter((c) => c.method === "notes.create").pop();
    expect((created?.params as { folder?: string }).folder).toBe("Thinkers/French");
    expect(shell.recordActionsFor([shell.records.get(list.id)!]).map((a) => a.label)).toContain("Move to folder…");
  });

  it("places dragged things between others, arranging the folder by hand, and undoes it", async () => {
    const { shell } = await boot();
    shell.router.go("notes", {});
    await wait(30);
    expect(names()).toEqual(["Empty", "Thinkers", "Reading list"]);
    // The top edge of a folder places beside it; its middle would move into it.
    expect(drag(row("Reading list"), row("Empty"), "before")).toBe("drop-before");
    await wait(30);
    expect(names()).toEqual(["Reading list", "Empty", "Thinkers"]);
    expect(shell.prefs.pref("folders.sort.note", { key: "name", dir: 1 })().key).toBe("manual");
    expect(mock.state.order.note![""]).toEqual([expect.any(String), "folder:Empty", "folder:Thinkers"]);
    // An item's bottom edge places after it.
    expect(drag(row("Empty"), row("Thinkers"), "after")).toBe("drop-after");
    await wait(30);
    expect(names()).toEqual(["Reading list", "Thinkers", "Empty"]);
    // The sidebar shows the same order.
    const tree = [...document.querySelectorAll(".tree [role=treeitem]")].map((t) => t.textContent);
    expect(tree.indexOf("Thinkers")).toBeLessThan(tree.indexOf("Empty"));
    await shell.undo.undoLast();
    await wait(30);
    expect(names()).toEqual(["Reading list", "Empty", "Thinkers"]);
    // ⌥↓ moves the selection one place down.
    row("Empty").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    key(row("Empty"), "ArrowDown", { altKey: true });
    await wait(30);
    expect(names()).toEqual(["Reading list", "Thinkers", "Empty"]);
    // Something from another folder is moved here, to that place.
    shell.router.go("notes", { folder: "Thinkers" });
    await wait(30);
    expect(drag(row("Jacques Ellul"), row("French"), "before")).toBe("drop-before");
    await wait(30);
    expect(names()).toEqual(["Jacques Ellul", "French"]);
  });
});

describe("daily notes", () => {
  it("are notes at the top level of Notes, opened (or made) from the ribbon's Today", async () => {
    last?.destroy();
    mock.reset();
    mock.state.folder = "/lib";
    seed("note", "2026-10-01", "Morning.\n", { "daily.date": "2026-10-01" });
    seed("note", "Reading list");
    document.body.innerHTML = '<div id="app"></div>';
    const shell = createShell(document.getElementById("app")!, [notes, daily]);
    last = shell;
    await wait(60);
    // Today: one is made at the top level, and opened; a second press opens the same one.
    document.querySelector<HTMLElement>('.ribbon [data-page="today"]')!.click();
    await wait(40);
    const dailies = () => shell.records.list("note").filter((r) => r.fields["daily.date"]);
    expect(dailies()).toHaveLength(2);
    const today = dailies().find((r) => r.fields["daily.date"] !== "2026-10-01")!;
    expect(shell.router.current()).toEqual({ page: "note", params: { id: today.id } });
    expect(folderOf(today)).toBe("");
    document.querySelector<HTMLElement>('.ribbon [data-page="today"]')!.click();
    await wait(40);
    expect(dailies()).toHaveLength(2);
    // On the Notes page they are notes like any other.
    shell.router.go("notes", {});
    await wait(30);
    expect(names()).toEqual(expect.arrayContaining(["2026-10-01", "Reading list", today.title]));
    expect(names()).not.toContain("Daily notes");
    // …and can be put in a folder like any other.
    expect(shell.recordActionsFor([today]).map((a) => a.label)).toContain("Move to folder…");
  });
});

describe("the sidebar", () => {
  it("has a Notes tree and a Library tree, each with its own folders, and captures under their items", async () => {
    const { shell, book } = await boot();
    const { call } = await import("./mock/backend");
    await call("captures.create", { source: book.id, snapshot: null, text: null, parts: [{ selector: [], quote: "Technique integrates everything.", locator: "p. 1", region_png: null, boxes: [] }], words: "" }).catch(() => null);
    seed("capture", "Technique integrates everything.", "", { "captures.source": book.id });
    await shell.records.load();
    await wait(30);
    const labels = () => [...document.querySelectorAll(".tree [role=treeitem]")].map((t) => `${t.getAttribute("aria-level")} ${t.textContent}`);
    expect(labels()).toEqual(expect.arrayContaining(["1 Notes", "2 Empty", "2 Thinkers", "3 French", "3 Jacques Ellul", "2 Reading list", "1 Library", "2 Thinkers", "3 On attention", "2 The Technological Society"]));
    expect(labels().some((l) => l.endsWith("Folders") || l.endsWith("Captures"))).toBe(false);
    // An item's captures are folded under it until it is unfolded.
    expect(labels()).not.toContain("3 Technique integrates everything.");
    const item = [...document.querySelectorAll<HTMLElement>(".tree [role=treeitem]")].find((t) => t.textContent === "The Technological Society")!;
    expect(item.getAttribute("aria-expanded")).toBe("false");
    item.querySelector<HTMLElement>(".tree-twisty")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await wait(10);
    expect(labels()).toContain("3 Technique integrates everything.");
    // A click on the item (not its arrow) opens it.
    [...document.querySelectorAll<HTMLElement>(".tree [role=treeitem]")].find((t) => t.textContent === "The Technological Society")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await wait(10);
    expect(shell.router.current()).toEqual({ page: "item", params: { id: book.id } });
  });
});

describe("the sidebar's menus", () => {
  const treeRow = (text: string) => [...document.querySelectorAll<HTMLElement>(".tree [role=treeitem]")].find((t) => t.textContent === text)!;
  const rightClick = (el: Element) => el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
  const menu = () => [...document.querySelectorAll<HTMLElement>(".context-menu [role=menuitem]")].map((b) => b.textContent);
  const choose = (label: string) => [...document.querySelectorAll<HTMLElement>(".context-menu [role=menuitem]")].find((b) => b.textContent === label)!.click();
  const answer = async (text: string) => {
    await wait(10);
    const input = document.querySelector<HTMLInputElement>("dialog[open] input")!;
    input.value = text;
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    await wait(40);
  };

  it("renames a library item or a note from its row, and Undo puts the title back", async () => {
    const { shell, book } = await boot();
    rightClick(treeRow("The Technological Society"));
    expect(menu()).toContain("Rename…");
    choose("Rename…");
    await answer("Technique");
    expect(shell.records.get(book.id)!.title).toBe("Technique");
    await shell.undo.undoLast();
    await wait(30);
    expect(shell.records.get(book.id)!.title).toBe("The Technological Society");
  });

  it("offers Rename only for one record at a time", async () => {
    const { shell, book, list } = await boot();
    expect(shell.recordActionsFor([shell.records.get(book.id)!]).map((a) => a.label)).toContain("Rename…");
    expect(shell.recordActionsFor([shell.records.get(book.id)!, shell.records.get(list.id)!]).map((a) => a.label)).not.toContain("Rename…");
  });

  it("the Notes and Library headings open their pages and make folders", async () => {
    const { shell } = await boot();
    rightClick(treeRow("Library"));
    expect(menu()).toEqual(["Open Library", "Open in new tab", "New folder…"]);
    choose("Open Library");
    await wait(30);
    expect(shell.router.current().page).toBe("library");
    rightClick(treeRow("Notes"));
    choose("New folder…");
    await answer("Drafts");
    expect(mock.state.folders.has("note:Drafts")).toBe(true);
  });

  it("deletes a folder: an empty one at once; one with things in it archives them, after asking, with Undo", async () => {
    const { shell, ellul, weil } = await boot();
    rightClick(treeRow("Empty"));
    choose("Delete folder");
    await wait(40);
    expect(mock.state.folders.has("note:Empty")).toBe(false);
    // Thinkers holds two notes (one in French) and an empty folder.
    rightClick(treeRow("Thinkers"));
    choose("New folder inside…");
    await answer("Later");
    expect(mock.state.folders.has("note:Thinkers/Later")).toBe(true);
    rightClick(treeRow("Thinkers"));
    choose("Delete folder…");
    await wait(20);
    const dialog = document.querySelector("dialog[open]")!;
    expect(dialog.textContent).toContain("The 2 items inside go to the Archive");
    [...dialog.querySelectorAll("button")].find((b) => b.textContent === "Archive 2 items and delete")!.click();
    await wait(80);
    expect(shell.records.get(ellul.id)!.fields["archive.at"]).toBeTruthy();
    expect(shell.records.get(weil.id)!.fields["archive.at"]).toBeTruthy();
    expect(mock.state.folders.has("note:Thinkers/Later")).toBe(false);
    const shown = () => !!document.querySelector('.tree [data-id="folder:note:Thinkers"]');
    expect(shown()).toBe(false);
    await shell.undo.undoLast();
    await wait(60);
    expect(shell.records.get(ellul.id)!.fields["archive.at"]).toBeUndefined();
    expect(mock.state.folders.has("note:Thinkers/Later")).toBe(true);
    expect(shown()).toBe(true);
    await shell.undo.redoLast();
    await wait(60);
    expect(shell.records.get(weil.id)!.fields["archive.at"]).toBeTruthy();
  });

  it("asks before deleting, and Cancel leaves the folder as it is", async () => {
    const { shell, ellul } = await boot();
    rightClick(treeRow("Thinkers"));
    choose("Delete folder…");
    await wait(20);
    [...document.querySelector("dialog[open]")!.querySelectorAll("button")].find((b) => b.textContent === "Cancel")!.click();
    await wait(40);
    expect(shell.records.get(ellul.id)!.fields["archive.at"]).toBeUndefined();
  });

  it("the sidebar's empty space goes to Notes or the Library, or makes a folder in either", async () => {
    const { shell } = await boot();
    rightClick(document.querySelector(".sidebar-scroll")!);
    expect(menu()).toEqual(["Go to Notes", "Go to Library", "New folder in Notes…", "New folder in Library…"]);
    choose("Go to Notes");
    await wait(30);
    expect(shell.router.current().page).toBe("notes");
    rightClick(document.querySelector(".sidebar-scroll")!);
    choose("New folder in Library…");
    await answer("Papers");
    expect(mock.state.folders.has("item:Papers")).toBe(true);
  });
});
