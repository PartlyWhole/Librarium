/** Undo per place (decision 0060): each page keeps its own history while the app runs. */
import { describe, expect, it } from "vitest";
import { EditorView } from "@codemirror/view";
import { isolateHistory } from "@codemirror/commands";
import { anchors, mock, seed } from "./mock/backend";
import { createShell, type Shell } from "../src/shell/shell";
import { notes } from "../src/features/notes";
import { library } from "../src/features/library";
import { captures } from "../src/features/captures";
import { archive } from "../src/features/archive";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
let last: Shell | null = null;

async function boot() {
  last?.destroy();
  mock.reset();
  mock.state.folder = "/lib";
  const a = seed("note", "Essay", "One.");
  const b = seed("note", "Other", "Two.");
  document.body.innerHTML = '<div id="app"></div>';
  const shell = createShell(document.getElementById("app")!, [notes, library, captures, archive]);
  last = shell;
  await wait(50);
  return { shell, a, b };
}
const editor = () => EditorView.findFromDOM(document.querySelector(".cm-editor") as HTMLElement)!;
/** Typing, as its own undo step. */
const type = (text: string) => {
  const v = editor();
  v.dispatch({ changes: { from: v.state.doc.length, insert: text }, userEvent: "input.type", annotations: isolateHistory.of("full") });
};
const press = async (shell: Shell, id: "edit.undo" | "edit.redo") => {
  await shell.actions.run(id);
  await wait(60);
};

describe("a note's history", () => {
  it("undoes typing and renaming on its page in the order they were done", async () => {
    const { shell, a } = await boot();
    shell.router.go("note", { id: a.id });
    await wait(60);
    type(" Two.");
    const title = document.querySelector(".title-input") as HTMLInputElement;
    title.value = "Essay on technique";
    title.dispatchEvent(new Event("blur"));
    await wait(60);
    type(" Three.");
    expect(editor().state.doc.toString()).toBe("One. Two. Three.");
    // The Edit menu says what Undo will do.
    const undoTitle = () => shell.actions.all().find((x) => x.id === "edit.undo")!.title;
    expect(undoTitle()).toBe("Undo Typing");
    await press(shell, "edit.undo");
    expect(editor().state.doc.toString()).toBe("One. Two.");
    expect(shell.records.get(a.id)?.title).toBe("Essay on technique");
    expect(undoTitle()).toBe("Undo rename to “Essay on technique”");
    await press(shell, "edit.undo");
    expect(shell.records.get(a.id)?.title).toBe("Essay");
    expect(editor().state.doc.toString()).toBe("One. Two.");
    await press(shell, "edit.undo");
    expect(editor().state.doc.toString()).toBe("One.");
    // And forward again, in order.
    await press(shell, "edit.redo");
    expect(editor().state.doc.toString()).toBe("One. Two.");
    await press(shell, "edit.redo");
    expect(shell.records.get(a.id)?.title).toBe("Essay on technique");
  });

  it("is kept when leaving the note and coming back", async () => {
    const { shell, a, b } = await boot();
    shell.router.go("note", { id: a.id });
    await wait(60);
    type(" Two.");
    await wait(1200); // saved
    shell.router.go("note", { id: b.id });
    await wait(60);
    type(" More.");
    shell.router.go("note", { id: a.id });
    await wait(80);
    expect(editor().state.doc.toString()).toBe("One. Two.");
    await press(shell, "edit.undo");
    expect(editor().state.doc.toString()).toBe("One.");
    // The other note's typing is its own.
    shell.router.go("note", { id: b.id });
    await wait(80);
    expect(editor().state.doc.toString()).toBe("Two. More.");
  });

  it("forgets the typing (not the rest) if the note changed outside meanwhile", async () => {
    const { shell, a, b } = await boot();
    shell.router.go("note", { id: a.id });
    await wait(60);
    type(" Two.");
    await wait(1200);
    shell.router.go("note", { id: b.id });
    await wait(60);
    mock.state.records.get(a.id)!.body = "Changed elsewhere.";
    shell.router.go("note", { id: a.id });
    await wait(80);
    expect(editor().state.doc.toString()).toBe("Changed elsewhere.");
    await press(shell, "edit.undo");
    expect(editor().state.doc.toString()).toBe("Changed elsewhere.");
  });
});

describe("the Library & notes history", () => {
  it("is what ⌘Z undoes away from a record's page, and not inside a note", async () => {
    const { shell, a, b } = await boot();
    await shell.recordActions.get("archive")!.run([shell.records.get(b.id)!]);
    await wait(30);
    expect(shell.records.get(b.id)?.fields["archive.at"]).toBeTruthy();
    // On a note, ⌘Z is the note's own history: the archiving stays.
    shell.router.go("note", { id: a.id });
    await wait(60);
    await press(shell, "edit.undo");
    expect(shell.records.get(b.id)?.fields["archive.at"]).toBeTruthy();
    // On a page of the Library, it is undone.
    shell.router.go("captures", {});
    await wait(60);
    // Its search box has the focus (⌘Z would be its own); click away from it first.
    (document.activeElement as HTMLElement | null)?.blur();
    await press(shell, "edit.undo");
    expect(shell.records.get(b.id)?.fields["archive.at"]).toBeFalsy();
  });
});

describe("the part of the window last worked in", () => {
  it("after a menu opened from the sidebar, ⌘Z is the sidebar's, even on a note; a click in the page makes it the note's", async () => {
    const { shell, a, b } = await boot();
    shell.router.go("note", { id: a.id });
    await wait(60);
    type(" Two.");
    // A click in the sidebar, then an action from its menu (the focus ends up nowhere).
    document.querySelector(".app-sidebar")!.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    (document.activeElement as HTMLElement | null)?.blur();
    await shell.recordActions.get("archive")!.run([shell.records.get(b.id)!]);
    await wait(30);
    await press(shell, "edit.undo");
    expect(shell.records.get(b.id)?.fields["archive.at"]).toBeFalsy();
    expect(editor().state.doc.toString()).toBe("One. Two.");
    // Back in the page: the note's own.
    document.querySelector(".workspace")!.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    await press(shell, "edit.undo");
    expect(editor().state.doc.toString()).toBe("One.");
  });
});

describe("a capture's history", () => {
  it("deleting stays on its page, which says so; ⌘Z there restores it", async () => {
    const { shell } = await boot();
    const src = seed("item", "The Technological Society", "", { "library.format": "pdf" });
    const cap = seed("capture", "It avoids shock", "", { "captures.source": src.id, "captures.quote": "It avoids shock.", "captures.parts": 1 });
    anchors.set(cap.id, { id: cap.id, source: src.id, snapshot: null, parts: [{ selector: [{ type: "TextQuoteSelector", exact: "It avoids shock.", prefix: "", suffix: "" }] }] });
    await shell.records.load();
    shell.router.go("capture", { id: cap.id });
    await wait(100);
    (document.querySelector('[aria-label="Delete capture"]') as HTMLButtonElement).click();
    await wait(120);
    expect(shell.records.get(cap.id)?.fields["archive.at"]).toBeTruthy();
    expect(shell.router.current()).toMatchObject({ page: "capture", params: { id: cap.id } });
    expect(document.querySelector(".notice")?.textContent).toContain("in the archive");
    await press(shell, "edit.undo");
    await wait(60);
    expect(shell.records.get(cap.id)?.fields["archive.at"]).toBeFalsy();
    expect(document.querySelector(".notice")).toBeNull();
  });
});
