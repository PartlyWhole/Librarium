/** Notes: the editor, autosave, drafts, links, renames and ⌘T — against the mock backend. */
import { beforeEach, describe, expect, it } from "vitest";
import { EditorView } from "@codemirror/view";
import { startCompletion, acceptCompletion, completionStatus } from "@codemirror/autocomplete";
import { mock, seed } from "./mock/backend";
import { createShell, type Shell } from "../src/shell/shell";
import { notes } from "../src/features/notes";
import { daily } from "../src/features/daily";
import { library } from "../src/features/library";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
let last: Shell | null = null;

async function open(body = "first line\n"): Promise<{ shell: Shell; id: string; view: EditorView }> {
  last?.destroy();
  mock.reset();
  mock.state.folder = "/lib";
  const n = seed("note", "Ellul", body);
  seed("note", "Simone Weil", "");
  document.body.innerHTML = '<div id="app"></div>';
  const shell = createShell(document.getElementById("app")!, [notes, daily, library]);
  last = shell;
  await wait(50);
  shell.router.go("note", { id: n.id });
  await wait(50);
  const view = EditorView.findFromDOM(document.querySelector(".cm-editor") as HTMLElement)!;
  return { shell, id: n.id, view };
}

function type(view: EditorView, text: string) {
  const at = view.state.doc.length;
  view.dispatch({ changes: { from: at, insert: text }, selection: { anchor: at + text.length }, userEvent: "input.type" });
}

beforeEach(() => document.querySelectorAll("dialog, .toast-host").forEach((d) => d.remove()));

describe("autosave", () => {
  it("keeps a draft within about 300 ms and saves after 1 s idle", async () => {
    const { id, view } = await open();
    type(view, "typed");
    await wait(450);
    expect(mock.state.drafts.get(id)?.body).toBe("first line\ntyped");
    expect(mock.state.records.get(id)!.body).toBe("first line\n");
    await wait(800);
    expect(mock.state.records.get(id)!.body).toBe("first line\ntyped");
    expect(mock.state.drafts.has(id)).toBe(false);
  });

  it("saves on navigation and on blur", async () => {
    const { shell, id, view } = await open();
    type(view, "before leaving");
    shell.router.go("notes");
    await wait(50);
    expect(mock.state.records.get(id)!.body).toBe("first line\nbefore leaving");
  });

  it("retries a failed save, says so, and keeps the text", async () => {
    const { shell, id, view } = await open();
    mock.state.failSave = "“Ellul” is read-only, so it can’t be saved.";
    type(view, "precious words");
    await wait(1300);
    expect(shell.status.message()).toContain("Couldn’t save");
    expect(shell.status.message()).toContain("Trying again");
    expect(mock.state.drafts.get(id)?.body).toBe("first line\nprecious words");
    mock.state.failSave = null;
    await wait(2200);
    expect(mock.state.records.get(id)!.body).toBe("first line\nprecious words");
    expect(shell.status.message()).toBe("Saved.");
  });

  it("offers back a draft newer than the file", async () => {
    last?.destroy();
    mock.reset();
    mock.state.folder = "/lib";
    const n = seed("note", "Recovered", "on disk\n");
    mock.state.drafts.set(n.id, { id: n.id, base_version: n.version, base_body: "on disk\n", body: "on disk\nunsaved\n", updated_ms: 1 });
    document.body.innerHTML = '<div id="app"></div>';
    const shell = createShell(document.getElementById("app")!, [notes, daily]);
    last = shell;
    await wait(50);
    expect(document.querySelector(".toast")?.textContent).toContain("recovered");
    shell.openRecord(n.id);
    await wait(50);
    const view = EditorView.findFromDOM(document.querySelector(".cm-editor") as HTMLElement)!;
    expect(view.state.doc.toString()).toBe("on disk\nunsaved\n");
    expect(document.querySelector(".notice")?.textContent).toContain("recovered");
    await wait(1200);
    expect(mock.state.records.get(n.id)!.body).toBe("on disk\nunsaved\n");
  });
});

describe("links", () => {
  it("[[ inserts [[label|id]]", async () => {
    const { shell, view } = await open("");
    const weil = shell.records.list("note").find((r) => r.title === "Simone Weil")!;
    view.focus();
    type(view, "See [[Wei");
    startCompletion(view);
    await wait(100);
    expect(completionStatus(view.state)).toBe("active");
    await wait(150); // CodeMirror ignores an accept within its interaction delay
    expect(acceptCompletion(view)).toBe(true);
    expect(view.state.doc.toString()).toBe(`See [[Simone Weil|${weil.id}]]`);
  });

  it("live preview shows only the label away from the cursor", async () => {
    const { shell, view } = await open("");
    const weil = shell.records.list("note").find((r) => r.title === "Simone Weil")!;
    view.dispatch({ changes: { from: 0, insert: `**bold** and [[Weil|${weil.id}]]\nsecond line` }, selection: { anchor: 30 + weil.id.length } });
    view.dispatch({ selection: { anchor: view.state.doc.length } });
    const first = view.contentDOM.querySelector(".cm-line")!;
    expect(first.textContent).toBe("bold and Weil");
    expect(first.querySelector(".cm-wikilink")?.getAttribute("data-id")).toBe(weil.id);
    view.dispatch({ selection: { anchor: 1 } });
    expect(view.contentDOM.querySelector(".cm-line")!.textContent).toContain("**bold**");
  });

  it("clicking a link opens its record", async () => {
    const { shell, view } = await open("");
    const weil = shell.records.list("note").find((r) => r.title === "Simone Weil")!;
    view.dispatch({ changes: { from: 0, insert: `[[Weil|${weil.id}]]\nx` }, selection: { anchor: 0 } });
    view.dispatch({ selection: { anchor: view.state.doc.length } });
    (view.contentDOM.querySelector(".cm-wikilink") as HTMLElement).dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(shell.router.current().params.id).toBe(weil.id);
  });
});

describe("renames and ⌘T", () => {
  it("renaming from the title offers undo, and undo refuses after a later edit", async () => {
    const { shell, id } = await open();
    const input = document.querySelector(".title-input") as HTMLInputElement;
    input.value = "Jacques Ellul";
    input.dispatchEvent(new Event("blur"));
    await wait(30);
    expect(mock.state.records.get(id)!.info.title).toBe("Jacques Ellul");
    expect(mock.state.records.get(id)!.info.path).toContain("jacques-ellul");
    expect(document.querySelector(".toast")?.textContent).toContain("Undo");
    await shell.undo.undoLast();
    expect(mock.state.records.get(id)!.info.title).toBe("Ellul");

    input.value = "Third";
    input.dispatchEvent(new Event("blur"));
    await wait(30);
    mock.state.records.get(id)!.info.version = "changed-outside";
    await shell.undo.undoLast();
    expect(mock.state.records.get(id)!.info.title).toBe("Third");
    expect(document.querySelector(".toast")?.textContent).toContain("can’t be undone");
  });

  it("⌘T opens today's note, and pressing it twice makes one note", async () => {
    const { shell } = await open();
    const key = () => document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "t", code: "KeyT", metaKey: true, bubbles: true, cancelable: true }));
    key();
    await wait(30);
    key();
    await wait(30);
    const dailies = shell.records.list("note").filter((r) => r.fields["daily.date"]);
    expect(dailies).toHaveLength(1);
    expect(shell.router.current().page).toBe("note");
    expect(shell.router.current().params.id).toBe(dailies[0]!.id);
  });

  it("⌘N makes a new note and focuses its title", async () => {
    const { shell } = await open();
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "n", code: "KeyN", metaKey: true, bubbles: true, cancelable: true }));
    await wait(60);
    expect(shell.records.get(shell.router.current().params.id!)?.title).toBe("Untitled");
    expect(document.activeElement?.classList.contains("title-input")).toBe(true);
  });
});
