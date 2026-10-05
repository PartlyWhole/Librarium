/** Archive and permanent deletion (§8, milestone 9): nothing is deleted without the two steps. */
import { describe, expect, it } from "vitest";
import { mock, seed } from "./mock/backend";
import { createShell, type Shell } from "../src/shell/shell";
import { notes } from "../src/features/notes";
import { search } from "../src/features/search";
import { archive } from "../src/features/archive";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
let last: Shell | null = null;

async function boot() {
  last?.destroy();
  mock.reset();
  mock.state.folder = "/lib";
  const a = seed("note", "Gravity and grace", "On attention.\n");
  const b = seed("note", "Keep", "On attention too.\n");
  document.body.innerHTML = '<div id="app"></div>';
  const shell = createShell(document.getElementById("app")!, [notes, search, archive]);
  last = shell;
  await wait(50);
  return { shell, a, b };
}

const buttons = (root: ParentNode, text: string) => [...root.querySelectorAll("button")].filter((b) => b.textContent?.includes(text));
const methods = () => mock.state.calls.map((c) => c.method);

async function archiveOpen(shell: Shell, id: string) {
  shell.openRecord(id);
  await wait(30);
  shell.actions.run("archive.archive");
  await wait(30);
}

describe("archive", () => {
  it("hides an archived note from lists and search, lists it in the Archive, and undoes", async () => {
    const { shell, a, b } = await boot();
    await archiveOpen(shell, a.id);
    expect(shell.records.list("note").map((r) => r.id)).toEqual([b.id]);
    expect(shell.records.list("note", { hidden: true })).toHaveLength(2);
    expect(shell.router.current().page).toBe("archive");
    expect(document.querySelector(".archive-list")?.textContent).toContain("Gravity and grace");
    // Search leaves it out.
    const { call } = await import("./mock/backend");
    const hits = await call<{ id: string }[]>("search.query", { text: "attention", hide: shell.hidingFields.values() });
    expect(hits.map((h) => h.id)).toEqual([b.id]);
    // Undo restores it.
    await shell.undo.undoLast();
    await wait(30);
    expect(shell.records.list("note")).toHaveLength(2);
    expect(document.querySelector(".archive-list")).toBeNull();
  });

  it("undoes and redoes several archivings, newest first", async () => {
    const { shell, a, b } = await boot();
    await archiveOpen(shell, a.id);
    await archiveOpen(shell, b.id);
    expect(shell.records.list("note")).toHaveLength(0);
    await shell.undo.undoLast();
    await wait(30);
    expect(shell.records.list("note").map((r) => r.id)).toEqual([b.id]);
    await shell.undo.undoLast();
    await wait(30);
    expect(shell.records.list("note")).toHaveLength(2);
    await shell.undo.redoLast();
    await wait(30);
    expect(shell.records.list("note").map((r) => r.id)).toEqual([b.id]);
    // A new action ends the redos.
    await archiveOpen(shell, b.id);
    expect(shell.undo.next()).toBeNull();
    expect(shell.records.list("note")).toHaveLength(0);
  });

  it("offers Archive only for unarchived records, Restore only for archived ones", async () => {
    const { shell, a } = await boot();
    shell.openRecord(a.id);
    await wait(30);
    const ids = () => shell.actions.all().filter((x) => !x.when || x.when()).map((x) => x.id);
    expect(ids()).toContain("archive.archive");
    expect(ids()).not.toContain("archive.restore");
    shell.actions.run("archive.archive");
    await wait(30);
    shell.openRecord(a.id);
    await wait(30);
    expect(ids()).not.toContain("archive.archive");
    expect(ids()).toContain("archive.restore");
    shell.actions.run("archive.restore");
    await wait(30);
    expect(shell.records.get(a.id)?.fields["archive.at"]).toBeUndefined();
  });

  it("deletes only after the explicit confirmation; Cancel and Escape delete nothing", async () => {
    const { shell, a } = await boot();
    await archiveOpen(shell, a.id);

    // Cancel.
    buttons(document, "Delete permanently…")[0]!.click();
    await wait(30);
    let dialog = document.querySelector("dialog")!;
    expect(dialog.textContent).toContain("can’t be undone");
    expect(document.activeElement?.textContent).toBe("Cancel");
    buttons(dialog, "Cancel")[0]!.click();
    await wait(30);
    expect(methods()).not.toContain("archive.delete");

    // Escape.
    buttons(document, "Delete permanently…")[0]!.click();
    await wait(30);
    dialog = document.querySelector("dialog")!;
    dialog.dispatchEvent(new Event("cancel"));
    await wait(30);
    expect(methods()).not.toContain("archive.delete");
    expect(mock.state.deleted).toEqual([]);
    expect(shell.records.get(a.id)).toBeDefined();

    // Confirmed.
    buttons(document, "Delete permanently…")[0]!.click();
    await wait(30);
    buttons(document.querySelector("dialog")!, "Delete permanently")[0]!.click();
    await wait(50);
    expect(mock.state.deleted).toHaveLength(1);
    expect(shell.records.get(a.id)).toBeUndefined();
    // Every delete followed a prepared confirmation.
    const m = methods();
    expect(m.indexOf("archive.prepareDelete")).toBeLessThan(m.indexOf("archive.delete"));
  });

  it("refuses to delete what isn't archived, even if asked directly", async () => {
    const { b } = await boot();
    const { call } = await import("./mock/backend");
    await expect(call("archive.prepareDelete", { ids: [b.id] })).rejects.toThrow(/Archive it first/);
    await expect(call("archive.delete", { token: "guess" })).rejects.toThrow(/expired/);
    expect(mock.state.deleted).toEqual([]);
  });
});

describe("a record's context menu", () => {
  const menuItems = () => [...document.querySelectorAll(".context-menu [role=menuitem]")].map((b) => b.textContent);
  const choose = (label: string) => ([...document.querySelectorAll(".context-menu [role=menuitem]")].find((b) => b.textContent === label) as HTMLElement).click();
  const row = (title: string) => [...document.querySelectorAll(".tree [role=treeitem]")].find((x) => x.textContent?.includes(title)) as HTMLElement;

  it("archives from a right-click in the sidebar, and restores from the Archive page", async () => {
    const { shell, a } = await boot();
    row("Gravity and grace").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 50, clientY: 60 }));
    expect(menuItems()).toEqual(["Open", "Open in new tab", "Move to folder…", "Archive"]);
    choose("Archive");
    await wait(30);
    expect(document.querySelector(".context-menu")).toBeNull();
    expect(shell.records.list("note").map((r) => r.id)).not.toContain(a.id);
    expect(row("Gravity and grace")).toBeUndefined();
    shell.router.go("archive");
    await wait(30);
    document.querySelector(".archive-row")!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 50, clientY: 60 }));
    expect(menuItems()).toEqual(["Open", "Open in new tab", "Restore from archive", "Delete permanently…"]);
    choose("Restore from archive");
    await wait(30);
    expect(shell.records.get(a.id)?.fields["archive.at"]).toBeUndefined();
  });

  it("opens from the keyboard (⇧F10), moves with the arrows and closes with Escape", async () => {
    await boot();
    const it = row("Keep");
    it.focus();
    it.dispatchEvent(new KeyboardEvent("keydown", { key: "F10", shiftKey: true, bubbles: true }));
    expect(menuItems()).toEqual(["Open", "Open in new tab", "Move to folder…", "Archive"]);
    expect(document.activeElement?.textContent).toBe("Open");
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown" }));
    expect(document.activeElement?.textContent).toBe("Open in new tab");
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown" }));
    expect(document.activeElement?.textContent).toBe("Move to folder…");
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown" }));
    expect(document.activeElement?.textContent).toBe("Archive");
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(document.querySelector(".context-menu")).toBeNull();
    expect(document.activeElement).toBe(it);
  });

  it("deleting from the menu still asks first, and only for archived records", async () => {
    const { a } = await boot();
    row("Gravity and grace").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
    expect(menuItems()).not.toContain("Delete permanently…");
    choose("Archive");
    await wait(30);
    const { shell } = { shell: last! };
    shell.router.go("archive");
    await wait(30);
    document.querySelector(".archive-row")!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
    choose("Delete permanently…");
    await wait(30);
    const dialog = document.querySelector("dialog")!;
    expect(dialog.textContent).toContain("can’t be undone");
    buttons(dialog, "Cancel")[0]!.click();
    await wait(30);
    expect(mock.state.deleted).toEqual([]);
    expect(last!.records.get(a.id)).toBeDefined();
  });
});
