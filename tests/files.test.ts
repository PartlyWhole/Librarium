/** Files: folders across notes and library items, browsed and organised as in Finder. */
import { describe, expect, it } from "vitest";
import { mock, seed } from "./mock/backend";
import { createShell, type Shell } from "../src/shell/shell";
import { notes } from "../src/features/notes";
import { library } from "../src/features/library";
import { archive } from "../src/features/archive";
import { files } from "../src/features/files";
import { Contents, folderOf, sortEntries, uniqueName, type Entry } from "../src/features/files/model";

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
  mock.state.folders.add("Empty");
  document.body.innerHTML = '<div id="app"></div>';
  const shell = createShell(document.getElementById("app")!, [notes, files, library, archive]);
  last = shell;
  await wait(60);
  return { shell, ellul, weil, list, book, page };
}

const rows = () => [...document.querySelectorAll<HTMLElement>(".files-body [role=option]")];
const names = () => rows().map((r) => r.querySelector(".files-name-text")?.textContent ?? "");
const row = (name: string) => rows().find((r) => r.querySelector(".files-name-text")?.textContent === name)!;
const key = (el: Element, k: string, o: KeyboardEventInit = {}) => el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...o }));
const methods = () => mock.state.calls.map((c) => c.method);

/** A pointer drag of `from` released over `to` (jsdom has no layout: the hit test is stubbed). */
function drag(from: HTMLElement, to: HTMLElement) {
  const at = { clientX: 10, clientY: 10, bubbles: true, button: 0 };
  document.elementFromPoint = () => to;
  from.dispatchEvent(new PointerEvent("pointerdown", at));
  window.dispatchEvent(new PointerEvent("pointermove", { ...at, clientX: 40, clientY: 40 }));
  const accepted = to.classList.contains("drop-over");
  window.dispatchEvent(new PointerEvent("pointerup", { ...at, clientX: 40, clientY: 40 }));
  return accepted;
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
    const c = new Contents(["Empty"], [weil, ellul], ["note", "item"], hidden);
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
  });
});

describe("the Files page", () => {
  it("shows a folder's folders first, then notes and items together, with their kinds", async () => {
    const { shell } = await boot();
    shell.router.go("files", {});
    await wait(30);
    expect(names()).toEqual(["Empty", "Thinkers", "Reading list", "The Technological Society"]);
    expect(row("Thinkers").textContent).toContain("Folder · 3 items");
    expect(row("The Technological Society").textContent).toContain("PDF");
    expect(document.querySelector(".files-crumbs")?.textContent).toBe("Reading room");
    expect(document.querySelector(".files-foot")?.textContent).toBe("2 folders, 2 items");
    // A double-click opens a folder; the path shows where one is.
    row("Thinkers").dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    await wait(30);
    expect(shell.router.current().params.folder).toBe("Thinkers");
    expect(names()).toEqual(["French", "Jacques Ellul", "On attention"]);
    expect([...document.querySelectorAll(".crumb")].map((c) => c.textContent)).toEqual(["Reading room", "Thinkers"]);
    expect(shell.here()).toBe("Thinkers");
  });

  it("selects with clicks (⌘ and ⇧ for several) and opens with Return; ⌘↑ goes up to where one was", async () => {
    const { shell, list } = await boot();
    shell.router.go("files", {});
    await wait(30);
    row("Empty").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    row("The Technological Society").dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: true }));
    expect(rows().filter((r) => r.classList.contains("selected"))).toHaveLength(4);
    row("Thinkers").dispatchEvent(new MouseEvent("click", { bubbles: true, metaKey: true }));
    expect(rows().filter((r) => r.getAttribute("aria-selected") === "true").map((r) => r.textContent?.split("Folder")[0])).not.toContain("Thinkers");
    expect(document.querySelector(".files-foot")?.textContent).toContain("3 selected");
    // A plain click selects only; it never opens.
    row("Reading list").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(shell.router.current().page).toBe("files");
    key(row("Reading list"), "Enter");
    await wait(30);
    expect(shell.router.current()).toEqual({ page: "note", params: { id: list.id } });
    shell.router.go("files", { folder: "Thinkers/French" });
    await wait(30);
    key(rows()[0]!, "ArrowUp", { metaKey: true });
    await wait(30);
    expect(shell.router.current().params.folder).toBe("Thinkers");
    expect(document.activeElement?.textContent).toContain("French");
  });

  it("moves what is dragged onto a folder, a part of the path or the sidebar, and undoes it", async () => {
    const { shell, book, list } = await boot();
    shell.router.go("files", {});
    await wait(30);
    // Several selected travel together.
    row("Reading list").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    row("The Technological Society").dispatchEvent(new MouseEvent("click", { bubbles: true, metaKey: true }));
    expect(drag(row("Reading list"), row("Thinkers"))).toBe(true);
    await wait(30);
    expect(names()).toEqual(["Empty", "Thinkers"]);
    expect(folderOf(shell.records.get(book.id)!)).toBe("Thinkers");
    expect(folderOf(shell.records.get(list.id)!)).toBe("Thinkers");
    await shell.undo.undoLast();
    await wait(30);
    expect(folderOf(shell.records.get(book.id)!)).toBe("");
    expect(folderOf(shell.records.get(list.id)!)).toBe("");
    // A folder into a folder; never into itself.
    expect(drag(row("Thinkers"), row("Thinkers"))).toBe(false);
    expect(drag(row("Thinkers"), row("Empty"))).toBe(true);
    await wait(30);
    expect(shell.records.get(book.id)!.path).toMatch(/^items\//);
    expect(methods()).toContain("folders.move");
    expect(names()).toEqual(["Empty", "Reading list", "The Technological Society"]);
    // Onto the sidebar's tree.
    const tree = () => [...document.querySelectorAll<HTMLElement>(".tree [role=treeitem]")];
    const target = tree().find((t) => t.textContent === "Empty")!;
    expect(drag(row("Reading list"), target)).toBe(true);
    await wait(30);
    expect(folderOf(shell.records.get(list.id)!)).toBe("Empty");
  });

  it("makes a folder named in place, renames with F2, and removes an empty one", async () => {
    const { shell } = await boot();
    shell.router.go("files", {});
    await wait(30);
    shell.actions.run("files.newFolder");
    await wait(30);
    const input = document.querySelector<HTMLInputElement>(".files-rename")!;
    expect(input.value).toBe("untitled folder");
    input.value = "Plato";
    key(input, "Enter");
    await wait(30);
    expect(names()).toContain("Plato");
    expect(mock.state.folders.has("Plato")).toBe(true);
    // F2 renames.
    row("Plato").focus();
    key(row("Plato"), "F2");
    const again = document.querySelector<HTMLInputElement>(".files-rename")!;
    again.value = "Platonists";
    key(again, "Enter");
    await wait(30);
    expect(names()).toContain("Platonists");
    expect(mock.state.folders.has("Plato")).toBe(false);
    // A folder with something in it is never removed.
    const { call } = await import("./mock/backend");
    await expect(call("folders.remove", { path: "Thinkers" })).rejects.toThrow(/isn’t empty/);
  });

  it("filters the folder, and switches to icons", async () => {
    const { shell } = await boot();
    shell.router.go("files", { folder: "Thinkers" });
    await wait(30);
    const filter = document.querySelector<HTMLInputElement>(".files-filter")!;
    filter.value = "atten";
    filter.dispatchEvent(new Event("input"));
    await wait(10);
    expect(names()).toEqual(["On attention"]);
    shell.prefs.pref("files.view", "list").set("icons");
    await wait(10);
    expect(document.querySelector(".files-body")?.classList.contains("icons")).toBe(true);
    expect(row("On attention").textContent).toContain("example.org");
  });

  it("hides archived items, and a folder holding only archived ones", async () => {
    const { shell, weil } = await boot();
    shell.router.go("files", { folder: "Thinkers" });
    await wait(30);
    expect(names()).toContain("French");
    const { call } = await import("./mock/backend");
    await call("archive.archive", { id: weil.id });
    await wait(30);
    expect(names()).not.toContain("French");
  });

  it("puts new notes into the folder being looked at, and offers Move to folder… in records' menus", async () => {
    const { shell, list } = await boot();
    shell.router.go("files", { folder: "Thinkers/French" });
    await wait(30);
    shell.actions.run("notes.new");
    await wait(30);
    const created = mock.state.calls.filter((c) => c.method === "notes.create").pop();
    expect((created?.params as { folder?: string }).folder).toBe("Thinkers/French");
    expect(shell.recordActionsFor([shell.records.get(list.id)!]).map((a) => a.label)).toContain("Move to folder…");
  });
});
