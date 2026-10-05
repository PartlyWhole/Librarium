/** Edit ▸ Undo and Redo (⌘Z, ⇧⌘Z): what has focus decides what they act on, and they grey out with nothing to undo. */
import { describe, expect, it } from "vitest";
import { EditorView } from "@codemirror/view";
import { mock, seed } from "./mock/backend";
import { menuSpec } from "../src/shell/menu";
import { createShell, type Shell } from "../src/shell/shell";
import { notes } from "../src/features/notes";
import { archive } from "../src/features/archive";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
let last: Shell | null = null;

async function boot() {
  last?.destroy();
  mock.reset();
  mock.state.folder = "/lib";
  const n = seed("note", "Draft", "first line\nsecond line\n");
  document.body.innerHTML = '<div id="app"></div>';
  const shell = createShell(document.getElementById("app")!, [notes, archive]);
  last = shell;
  await wait(60);
  return { shell, n };
}

/** Waits (up to 3 s) for a check to hold, as the view redraws a moment after a change. */
async function until(check: () => boolean) {
  for (let i = 0; i < 150 && !check(); i++) await wait(20);
}

describe("Edit ▸ Undo and Redo", () => {
  // Found by ID: their words name what they'd do ("Undo Typing", 0060).
  const item = (shell: Shell, which: "Undo" | "Redo") =>
    menuSpec(shell.actions).find((s) => s.title === "Edit")!.entries.find((e) => e.kind === "item" && e.id === (which === "Undo" ? "edit.undo" : "edit.redo")) as { enabled: boolean; run(): void; text: string };

  it("are greyed out with nothing to undo, and undo and redo the note's text", async () => {
    const { shell, n } = await boot();
    shell.openRecord(n.id);
    await until(() => !!document.querySelector(".workspace .cm-editor"));
    const view = EditorView.findFromDOM(document.querySelector<HTMLElement>(".workspace .cm-editor")!)!;
    view.focus();
    await wait(20);
    expect(item(shell, "Undo").enabled).toBe(false);
    expect(item(shell, "Redo").enabled).toBe(false);
    view.dispatch({ changes: { from: 0, insert: "New " }, userEvent: "input.type" });
    await wait(20);
    expect(item(shell, "Undo").enabled).toBe(true);
    expect(item(shell, "Undo").text).toBe("Undo Typing");
    item(shell, "Undo").run();
    await wait(20);
    expect(view.state.doc.toString()).toBe("first line\nsecond line\n");
    expect(item(shell, "Undo").enabled).toBe(false);
    expect(item(shell, "Redo").enabled).toBe(true);
    item(shell, "Redo").run();
    await wait(20);
    expect(view.state.doc.toString()).toBe("New first line\nsecond line\n");
  });

  it("away from text, undo and redo the app's actions, several deep; greyed out with none", async () => {
    const { shell, n } = await boot();
    shell.router.go("archive");
    await wait(40);
    (document.activeElement as HTMLElement | null)?.blur();
    await wait(20);
    expect(item(shell, "Undo").enabled).toBe(false);
    expect(item(shell, "Redo").enabled).toBe(false);
    const log: string[] = [];
    const step = (name: string) => ({ label: name, undo: async () => void log.push(`undo ${name}`), redo: async () => void log.push(`redo ${name}`) });
    shell.undo.done("Moved one.", step("one"));
    shell.undo.done("Moved two.", step("two"));
    await wait(20);
    expect(item(shell, "Undo").enabled).toBe(true);
    expect(item(shell, "Undo").text).toBe("Undo two");
    item(shell, "Undo").run();
    await wait(20);
    item(shell, "Undo").run();
    await wait(20);
    expect(item(shell, "Undo").enabled).toBe(false);
    item(shell, "Redo").run();
    await wait(20);
    expect(log).toEqual(["undo two", "undo one", "redo one"]);
    expect(item(shell, "Redo").enabled).toBe(true);
    void n;
  });

  it("in a note, ⌘Z stays the note's text (not the app's last action)", async () => {
    const { shell, n } = await boot();
    let undone = false;
    shell.undo.done("Moved one.", { label: "one", undo: async () => void (undone = true) });
    shell.openRecord(n.id);
    await until(() => !!document.querySelector(".workspace .cm-editor"));
    const view = EditorView.findFromDOM(document.querySelector<HTMLElement>(".workspace .cm-editor")!)!;
    view.focus();
    await wait(20);
    expect(item(shell, "Undo").enabled).toBe(false);
    item(shell, "Undo").run();
    await wait(20);
    expect(undone).toBe(false);
  });

  it("are on in a text field", async () => {
    const { shell } = await boot();
    const field = document.createElement("input");
    document.body.appendChild(field);
    field.focus();
    await wait(20);
    expect(item(shell, "Undo").enabled).toBe(true);
    field.remove();
  });
});
