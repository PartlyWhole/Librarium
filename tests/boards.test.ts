/**
 * Boards (docs/plans/boards.md, phase 2): made beside notes, saved with their readable page,
 * drafts recovered, outside changes, never merged silently, ⌘Z through the board's place.
 * Excalidraw itself needs a real browser (tests/webkit/board-check.ts); here a stand-in engine.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { call, mock, seed, EMPTY_BOARD, boardNote } from "./mock/backend";
import { createShell, type Shell } from "../src/shell/shell";
import { notes } from "../src/features/notes";
import { boards } from "../src/features/boards";
import { archive } from "../src/features/archive";
import { boardTimings, useBoardEngine } from "../src/features/boards/page";
import { boardPage } from "../src/features/boards/mirror";
import type { BoardElement, BoardEngine, BoardEngineOptions } from "../src/features/boards/engine";
import { recordScope } from "../src/shell/undo";
import { passThrough } from "../src/kit/keys";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(check: () => boolean) {
  for (let i = 0; i < 150 && !check(); i++) await wait(10);
}

/** A stand-in for Excalidraw: holds the drawing, counts undo, redo and loads. */
interface Fake {
  o: BoardEngineOptions;
  scene: string;
  loads: string[];
  undos: number;
  redos: number;
  destroyed: boolean;
  /** The user draws: a text (or a shape) is added. */
  draw(text?: string): void;
}
let engines: Fake[] = [];
const scene = (elements: BoardElement[]) => JSON.stringify({ type: "excalidraw", version: 2, source: "test", elements, appState: {}, files: {} });
const elementsOf = (s: string) => (JSON.parse(s) as { elements: BoardElement[] }).elements;

beforeEach(() => {
  engines = [];
  boardTimings.save = 30;
  boardTimings.draft = 10;
  boardTimings.retry = 50;
  useBoardEngine(async (host: HTMLElement, o: BoardEngineOptions): Promise<BoardEngine> => {
    const el = document.createElement("div");
    el.className = "excalidraw";
    el.tabIndex = 0;
    host.appendChild(el);
    const f: Fake = {
      o,
      scene: o.scene,
      loads: [],
      undos: 0,
      redos: 0,
      destroyed: false,
      draw(text) {
        const els = elementsOf(f.scene);
        els.push({ id: `e${els.length}`, type: text ? "text" : "rectangle", x: 10 * els.length, y: 0, ...(text ? { text } : {}) });
        f.scene = scene(els);
        o.onChange();
        o.onStep();
      },
    };
    engines.push(f);
    return {
      el,
      current: () => ({ scene: f.scene, elements: elementsOf(f.scene) }),
      load: (s) => void (f.loads.push(s), (f.scene = s)),
      // As the real engine does: Excalidraw's own key, sent to its canvas.
      undo: () => (f.undos++, el.dispatchEvent(passThrough(new KeyboardEvent("keydown", { key: "z", metaKey: true, bubbles: true, cancelable: true }))), true),
      redo: () => (f.redos++, el.dispatchEvent(passThrough(new KeyboardEvent("keydown", { key: "Z", metaKey: true, shiftKey: true, bubbles: true, cancelable: true }))), true),
      setTheme() {},
      destroy: () => void (f.destroyed = true),
    };
  });
});

let last: Shell | null = null;
afterEach(() => {
  last?.destroy();
  last = null;
});

async function boot() {
  mock.reset();
  mock.state.folder = "/lib";
  const note = seed("note", "Ellul", "On technique.\n", {}, "Thinkers");
  document.body.innerHTML = '<div id="app"></div>';
  const shell = createShell(document.getElementById("app")!, [notes, boards, archive]);
  last = shell;
  await wait(60);
  return { shell, note };
}

/** Makes a board beside the open note, and waits for its canvas. */
async function newBoard(shell: Shell) {
  shell.actions.run("boards.new");
  await until(() => engines.length > 0 && shell.router.current().page === "board");
  return { id: shell.router.current().params.id!, f: engines.at(-1)! };
}

describe("boards", () => {
  it("are made beside the note being read, kept in the Notes folders, and listed with notes", async () => {
    const { shell, note } = await boot();
    shell.openRecord(note.id);
    await wait(40);
    const { id } = await newBoard(shell);
    const r = shell.records.get(id)!;
    expect(r.kind).toBe("board");
    expect(r.path).toMatch(new RegExp(`^notes/Thinkers/${id}-untitled-board\\.md$`));
    expect(mock.state.scenes.get(id)).toBe(EMPTY_BOARD);
    expect(document.activeElement?.classList.contains("board-title")).toBe(true);
    // In the sidebar, under Thinkers, beside the note; and in the Notes page's folder.
    await wait(40);
    const rows = [...document.querySelectorAll<HTMLElement>(".tree [role=treeitem]")].map((t) => t.textContent);
    expect(rows).toContain("Untitled board");
    shell.router.go("notes", { folder: "Thinkers" });
    await wait(60);
    expect([...document.querySelectorAll(".files-body [role=option] .files-name-text")].map((n) => n.textContent)).toEqual(expect.arrayContaining(["Ellul", "Untitled board"]));
  });

  it("save the drawing and its readable page together, a moment after a change", async () => {
    const { shell } = await boot();
    const { id, f } = await newBoard(shell);
    f.draw("Technique");
    f.draw("Propaganda");
    // A draft is kept at once; then the board is saved, and the draft let go.
    await until(() => mock.state.drafts.has(id));
    expect(mock.state.drafts.get(id)!.body).toBe(f.scene);
    await until(() => mock.state.scenes.get(id) === f.scene);
    expect(mock.state.records.get(id)!.body).toBe(`${boardNote(id)}\n\nTechnique\n\nPropaganda\n`);
    await until(() => !mock.state.drafts.has(id));
    expect(mock.state.drafts.has(id)).toBe(false);
  });

  it("give back a drawing that wasn't saved, which can be discarded", async () => {
    const { shell } = await boot();
    const w = await call<{ info: { id: string; version: string } }>("boards.create", {});
    const id = w.info.id;
    const unsaved = scene([{ id: "a", type: "text", x: 0, y: 0, text: "Unsaved" }]);
    await call("drafts.put", { id, base_version: w.info.version, base_body: (await call<{ scene_sha: string }>("boards.load", { id })).scene_sha, body: unsaved });
    await shell.records.load();
    shell.openRecord(id);
    await until(() => engines.length > 0);
    const f = engines[0]!;
    expect(f.o.scene).toBe(unsaved);
    expect(document.querySelector(".notices")?.textContent).toContain("A drawing you hadn’t saved was recovered");
    // It is saved (it is the user's), unless discarded.
    await until(() => mock.state.scenes.get(id) === unsaved);
    expect(mock.state.records.get(id)!.body).toContain("Unsaved");
  });

  it("show a change made elsewhere, and never merge it silently with unsaved changes", async () => {
    const { shell } = await boot();
    const { id, f } = await newBoard(shell);
    await wait(40);
    // Changed elsewhere with nothing unsaved here: the board shows it.
    const theirs = scene([{ id: "x", type: "text", x: 0, y: 0, text: "From the other Mac" }]);
    const fresh = await call<{ info: { version: string }; scene_sha: string }>("boards.load", { id });
    await call("boards.save", { id, base_version: fresh.info.version, base_scene_sha: fresh.scene_sha, scene: theirs, page: "p\n" });
    await until(() => f.loads.length > 0);
    expect(f.loads.at(-1)).toBe(theirs);

    // Changed elsewhere while there are unsaved changes here: theirs is kept as a copy beside
    // it, and ours is saved.
    boardTimings.save = 400;
    f.draw("Mine");
    const other = scene([{ id: "y", type: "text", x: 0, y: 0, text: "Theirs again" }]);
    const now = await call<{ info: { version: string }; scene_sha: string }>("boards.load", { id });
    await call("boards.save", { id, base_version: now.info.version, base_scene_sha: now.scene_sha, scene: other, page: "p\n" });
    await until(() => mock.state.scenes.get(id) === f.scene);
    expect(elementsOf(mock.state.scenes.get(id)!).map((e) => e.text)).toContain("Mine");
    const copy = [...mock.state.records.values()].find((r) => r.info.title.endsWith("(version from elsewhere)"))!;
    expect(copy.info.kind).toBe("board");
    expect(mock.state.scenes.get(copy.info.id)).toBe(other);
    expect(copy.body).toContain("Theirs again");
    expect(document.body.textContent).toContain("was also changed elsewhere");
  });

  it("rewrite a page written from another drawing when opened", async () => {
    const { shell } = await boot();
    const w = await call<{ info: { id: string } }>("boards.create", {});
    const id = w.info.id;
    mock.state.scenes.set(id, scene([{ id: "a", type: "text", x: 0, y: 0, text: "Edited outside" }]));
    await shell.records.load();
    shell.openRecord(id);
    await until(() => mock.state.records.get(id)!.body.includes("Edited outside"));
    expect(mock.state.records.get(id)!.body).toBe(`${boardNote(id)}\n\nEdited outside\n`);
  });

  it("undo drawing steps and the board's own steps, in order, with ⌘Z", async () => {
    const { shell } = await boot();
    const { id, f } = await newBoard(shell);
    const title = document.querySelector<HTMLInputElement>(".board-title")!;
    title.value = "Map";
    title.dispatchEvent(new Event("blur"));
    await until(() => shell.records.get(id)?.title === "Map");
    f.draw();
    f.draw();
    (document.querySelector(".excalidraw") as HTMLElement).focus();
    const scope = recordScope(id);
    expect(shell.undo.undoLabel(scope)).toBe("Drawing");
    await shell.undo.undo(scope);
    await shell.undo.undo(scope);
    expect(f.undos).toBe(2);
    // Then the rename, done on the board's page.
    await shell.undo.undo(scope);
    await until(() => shell.records.get(id)?.title === "Untitled board");
    await shell.undo.redo(scope);
    await until(() => shell.records.get(id)?.title === "Map");
    await shell.undo.redo(scope);
    expect(f.redos).toBe(1);
  });

  it("undo one drawing step per ⌘Z pressed on the canvas (the key sent on to it isn't taken again)", async () => {
    const { shell } = await boot();
    const { id, f } = await newBoard(shell);
    const title = document.querySelector<HTMLInputElement>(".board-title")!;
    title.value = "Map";
    title.dispatchEvent(new Event("blur"));
    await until(() => shell.records.get(id)?.title === "Map");
    f.draw();
    f.draw();
    const canvas = document.querySelector<HTMLElement>(".excalidraw")!;
    canvas.focus();
    canvas.dispatchEvent(new KeyboardEvent("keydown", { key: "z", code: "KeyZ", metaKey: true, bubbles: true, cancelable: true }));
    await wait(30);
    expect(f.undos).toBe(1);
    expect(shell.records.get(id)?.title).toBe("Map");
  });

  it("can be moved to a folder with notes, and renamed from the sidebar", async () => {
    const { shell } = await boot();
    const { id } = await newBoard(shell);
    await wait(40);
    const r = shell.records.get(id)!;
    expect(shell.recordActionsFor([r]).map((a) => a.label)).toEqual(expect.arrayContaining(["Rename…", "Move to folder…"]));
  });
});

describe("a board's readable page", () => {
  it("is its texts in reading order, deleted ones left out, under the line saying what it is", () => {
    const els: BoardElement[] = [
      { id: "1", type: "text", x: 200, y: 0, text: "Right" },
      { id: "2", type: "text", x: 0, y: 4, text: "Left" },
      { id: "3", type: "text", x: 0, y: 100, text: "Below\nand on" },
      { id: "4", type: "rectangle", x: 0, y: 0 },
      { id: "5", type: "text", x: 0, y: 50, text: "Gone", isDeleted: true },
      { id: "6", type: "text", x: 0, y: 60, text: "   " },
    ];
    expect(boardPage("b1", els)).toBe(`${boardNote("b1")}\n\nLeft\n\nRight\n\nBelow\nand on\n`);
    expect(boardPage("b1", [])).toBe(`${boardNote("b1")}\n`);
  });
});
