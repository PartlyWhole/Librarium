/** Undo history: the side-panel view of what ⌘Z (a note's text) and Undo (app actions) act on. */
import { describe, expect, it } from "vitest";
import { EditorView } from "@codemirror/view";
import { isolateHistory, undo } from "@codemirror/commands";
import { mock, seed } from "./mock/backend";
import { createShell, type Shell } from "../src/shell/shell";
import { notes } from "../src/features/notes";
import { archive } from "../src/features/archive";
import { undoHistory } from "../src/features/undo-history";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
let last: Shell | null = null;

async function boot() {
  last?.destroy();
  mock.reset();
  mock.state.folder = "/lib";
  const n = seed("note", "Draft", "first line\nsecond line\n");
  document.body.innerHTML = '<div id="app"></div>';
  const shell = createShell(document.getElementById("app")!, [notes, archive, undoHistory]);
  last = shell;
  await wait(60);
  return { shell, n };
}

/** Waits (up to 3 s) for a check to hold, as the view redraws a moment after a change. */
async function until(check: () => boolean) {
  for (let i = 0; i < 150 && !check(); i++) await wait(20);
}

const steps = (cls: string) => [...document.querySelectorAll(`.undo-list.${cls} li`)].map((li) => li.textContent);

describe("undo history", () => {
  it("lists the note's text steps as ⌘Z would undo them, and the redo steps", async () => {
    const { shell, n } = await boot();
    shell.openRecord(n.id);
    await until(() => !!document.querySelector(".workspace .cm-editor"));
    const view = EditorView.findFromDOM(document.querySelector<HTMLElement>(".workspace .cm-editor")!)!;
    const end = view.state.doc.length;
    view.dispatch({ changes: { from: end, insert: "alpha" }, userEvent: "input.type", annotations: isolateHistory.of("full") });
    view.dispatch({ changes: { from: 0, to: 6 }, userEvent: "delete", annotations: isolateHistory.of("full") });
    shell.showPanelSection("undo-history");
    await until(() => steps("undo").length === 2);
    expect(steps("undo")).toEqual(["Deleted “first ”", "Typed “alpha”"]);
    expect(document.querySelector(".undo-list.undo li")!.classList.contains("next")).toBe(true);
    undo(view);
    await until(() => steps("redo").length === 1);
    expect(steps("undo")).toEqual(["Typed “alpha”"]);
    expect(steps("redo")).toEqual(["Deleted “first ”"]);
  });

  it("lists this session's app actions; only the latest can be undone", async () => {
    const { shell } = await boot();
    shell.router.go("archive");
    await wait(40);
    shell.showPanelSection("undo-history");
    await wait(40);
    expect(document.querySelector(".panel-section")!.textContent).toContain("Nothing yet this session.");
    let undone = "";
    shell.undo.done("Renamed to “One”.", { label: "rename to One", undo: async () => void (undone = "one") });
    shell.undo.done("Moved it to Reading.", { label: "move", undo: async () => void (undone = "move") });
    await wait(20);
    const items = () => [...document.querySelectorAll<HTMLElement>(".undo-list.app li")];
    expect(items().map((li) => li.className)).toEqual(["state-latest", "state-replaced"]);
    expect(items()[1]!.textContent).toContain("only the latest");
    items()[0]!.querySelector("button")!.click();
    await wait(20);
    expect(undone).toBe("move");
    expect(items()[0]!.className).toBe("state-undone");
    expect(items().some((li) => li.querySelector("button"))).toBe(false);
  });
});
