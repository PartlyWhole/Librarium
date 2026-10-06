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
import { captures } from "../src/features/captures";
import { library } from "../src/features/library";
import { boardTimings, useBoardEngine } from "../src/features/boards/page";
import { boardPage } from "../src/features/boards/mirror";
import type { BoardElement, BoardEngine, BoardEngineOptions, BoardInsert } from "../src/features/boards/engine";
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
  /** What is selected on the board. */
  selection: string[];
  /** What was put on the board, and where. */
  inserts: { items: BoardInsert[]; at?: { x: number; y: number } }[];
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
      selection: [],
      inserts: [],
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
      selected: () => f.selection,
      // As the real engine does: a card or picture element, linked, its link kept, `embed` marked.
      insert: async (items, at) => {
        f.inserts.push({ items, at });
        const els = elementsOf(f.scene);
        for (const it of items) els.push({ id: `c${els.length}`, type: it.picture ? "image" : "embeddable", x: 0, y: 200 + 50 * els.length, link: `librarium://record/${it.id}`, customData: { librarium: { links: [{ id: it.id, label: it.label }], ...(it.embed ? { embed: true } : {}) } } });
        f.scene = scene(els);
        o.onChange();
        o.onStep();
      },
      // As the real engine does: the link on the element, its links kept, [[ replaced by the name.
      link: (ids, to, opts = {}) => {
        const els = elementsOf(f.scene).map((e) => {
          if (!ids.includes(e.id)) return e;
          const links = [...(e.customData?.librarium?.links ?? []).filter((l) => l.id !== to.id), to];
          const text = e.type === "text" && opts.replaceTyped && e.text ? (e.text.endsWith("[[") ? e.text.slice(0, -2) : e.text) + to.label : e.text;
          return { ...e, text, link: `librarium://record/${links[0]!.id}`, customData: { librarium: { links } } };
        });
        f.scene = scene(els);
        o.onChange();
        o.onStep();
        return true;
      },
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

  it("save over a page changed elsewhere when the drawing is the same (link names refreshed): no copy", async () => {
    const { shell } = await boot();
    const { id, f } = await newBoard(shell);
    await wait(40);
    boardTimings.save = 300;
    f.draw("Mine");
    // The links' repair job rewrites the page (a linked note was renamed); the drawing is untouched.
    const r = mock.state.records.get(id)!;
    r.body = `${r.body}\nrefreshed\n`;
    r.info.version = `${r.info.version}-repaired`;
    mock.emit("event.change", { seq: 900, id, kind: "board", op: "updated", origin: "app" });
    await until(() => mock.state.scenes.get(id) === f.scene);
    expect(elementsOf(mock.state.scenes.get(id)!).map((e) => e.text)).toContain("Mine");
    expect([...mock.state.records.values()].some((x) => x.info.title.endsWith("(version from elsewhere)"))).toBe(false);
    expect(mock.state.records.get(id)!.body).not.toContain("refreshed");
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

/** Picks a title in the open picker. */
async function pick(text: string) {
  await until(() => !!document.querySelector("dialog[open] .combo-input"));
  const input = document.querySelector<HTMLInputElement>("dialog[open] .combo-input")!;
  input.value = text;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  await wait(20);
}

describe("links on boards", () => {
  it("[[ in a text links it to a record: the name replaces [[, and the record lists the board", async () => {
    const { shell, note } = await boot();
    const { id, f } = await newBoard(shell);
    f.draw("See [[");
    const textId = elementsOf(f.scene).at(-1)!.id;
    f.o.onLinkStart(textId);
    await pick("Ellul");
    const el = elementsOf(f.scene).find((e) => e.id === textId)!;
    expect(el.text).toBe("See Ellul");
    expect(el.link).toBe(`librarium://record/${note.id}`);
    // Saved: the readable page has the link, so the note's backlinks list the board.
    await until(() => mock.state.records.get(id)!.body.includes(`[[Ellul|${note.id}]]`));
    expect(mock.state.records.get(id)!.body).toBe(`${boardNote(id)}

See [[Ellul|${note.id}]]
`);
    const back = await call<{ source: string }[]>("links.backlinks", { id: note.id });
    expect(back.map((b) => b.source)).toContain(id);
  });

  it("Link to… links what is selected; renaming the record shows in the page at the next save", async () => {
    const { shell, note } = await boot();
    const { id, f } = await newBoard(shell);
    f.draw();
    f.selection = [elementsOf(f.scene)[0]!.id];
    expect(shell.actions.get("boards.linkTo")!.keys).toEqual(["Mod+Alt+K"]);
    shell.actions.run("boards.linkTo");
    await pick("Ellul");
    await until(() => mock.state.records.get(id)!.body.includes(`[[Ellul|${note.id}]]`));
    // Renamed: the link follows (by ID); its name is today's at the next save.
    await call("records.relocate", { id: note.id, title: "Jacques Ellul" });
    await shell.records.load();
    f.draw("And more");
    await until(() => mock.state.records.get(id)!.body.includes(`[[Jacques Ellul|${note.id}]]`));
    // Nothing selected: it says what to do.
    f.selection = [];
    shell.actions.run("boards.linkTo");
    expect(document.querySelector("dialog[open]")).toBeNull();
  });

  it("a click on a link opens the record (⌘: in a new tab); a web link asks first", async () => {
    const { shell, note } = await boot();
    const { f } = await newBoard(shell);
    // With ⌘, beside the board, in a new tab; then without, in this one.
    const tabs = shell.router.tabs().length;
    f.o.onOpenLink(`librarium://record/${note.id}`, true);
    await wait(20);
    expect(shell.router.tabs().length).toBe(tabs + 1);
    shell.router.select(0);
    await wait(20);
    f.o.onOpenLink(`librarium://record/${note.id}`, false);
    await wait(20);
    expect(shell.router.current()).toMatchObject({ page: "note", params: { id: note.id } });
    f.o.onOpenLink("https://example.org/essay", false);
    await until(() => !!document.querySelector("dialog[open]"));
    expect(document.querySelector("dialog[open]")!.textContent).toContain("example.org");
  });
});

describe("captures, notes, items and pictures on boards", () => {
  async function bootAll() {
    last?.destroy();
    mock.reset();
    mock.state.folder = "/lib";
    const note = seed("note", "Ellul", "On technique.\n", {}, "Thinkers");
    const src = seed("item", "The Technological Society", "", { "library.format": "pdf", "library.pages": 2 });
    const cap = seed("capture", "Technique integrates", "", { "captures.source": src.id, "captures.quote": "Technique integrates everything.", "captures.locator": "p. 1", "captures.parts": 1 });
    document.body.innerHTML = '<div id="app"></div>';
    const shell = createShell(document.getElementById("app")!, [notes, boards, library, captures, archive]);
    last = shell;
    await wait(60);
    return { shell, note, src, cap };
  }

  it("Put on the board… puts a capture as a card: its quotation and citation, kept current, written ![[…]]", async () => {
    const { shell, cap } = await bootAll();
    const { id, f } = await newBoard(shell);
    expect(shell.actions.get("boards.insert")!.keys).toEqual(["Mod+Alt+I"]);
    shell.actions.run("boards.insert");
    await pick("Technique integrates");
    await until(() => f.inserts.length > 0);
    expect(f.inserts[0]!.items).toEqual([{ id: cap.id, label: "Technique integrates", picture: false, embed: true }]);
    await until(() => mock.state.records.get(id)!.body.includes(`![[Technique integrates|${cap.id}]]`));
    // The card: the capture as notes show it, drawn again when the capture changes.
    const host = document.createElement("div");
    document.body.appendChild(host);
    const stop = f.o.renderCard(cap.id, host);
    expect(host.querySelector("blockquote")?.textContent).toBe("Technique integrates everything.");
    expect(host.textContent).toContain("The Technological Society");
    const changed = { ...shell.records.get(cap.id)!, version: "v2", fields: { ...shell.records.get(cap.id)!.fields, "captures.quote": "Technique integrates everything it meets." } };
    shell.records.put(changed, 999);
    await until(() => host.querySelector("blockquote")?.textContent === "Technique integrates everything it meets.");
    stop();
  });

  it("a note's card shows its name and opens it; a record that's gone says so", async () => {
    const { shell, note } = await bootAll();
    const { f } = await newBoard(shell);
    const host = document.createElement("div");
    document.body.appendChild(host);
    f.o.renderCard(note.id, host);
    expect(host.textContent).toContain("Ellul");
    expect(host.textContent).toContain("Note");
    host.querySelector<HTMLElement>(".board-card-link")!.click();
    await wait(20);
    expect(shell.router.current()).toMatchObject({ page: "note", params: { id: note.id } });
    const gone = document.createElement("div");
    f.o.renderCard("0192f3a4-7c1e-7b2a-9f00-0000000000ff", gone);
    expect(gone.textContent).toContain("deleted or can’t be found");
  });

  it("a picture pasted on a board becomes a library attachment, then goes on the board as a picture", async () => {
    const { shell } = await bootAll();
    const { id, f } = await newBoard(shell);
    const file = new File([new Uint8Array([137, 80, 78, 71])], "chart.png", { type: "image/png" });
    f.o.onFiles([file]);
    // (Earlier tests' apps leave the library's paste listener on the page; this app's is the one
    // whose records know the new picture.)
    await until(() => f.inserts.some((i) => i.items.length > 0));
    const item = f.inserts.find((i) => i.items.length > 0)!.items[0]!;
    expect(item).toMatchObject({ picture: true, embed: true, label: "chart" });
    const r = shell.records.get(item.id)!;
    expect(r.kind).toBe("item");
    expect(r.path.startsWith("items/Attachments/")).toBe(true);
    await until(() => mock.state.records.get(id)!.body.includes(`![[chart|${item.id}]]`));
  });

  it("a note dragged from the sidebar onto the board goes on it as a card", async () => {
    const { shell, note } = await bootAll();
    const { f } = await newBoard(shell);
    await wait(40);
    const row = [...document.querySelectorAll<HTMLElement>(".tree [role=treeitem]")].find((t) => t.textContent === "Ellul")!;
    const canvas = document.querySelector<HTMLElement>(".board-host")!;
    document.elementFromPoint = () => canvas;
    row.dispatchEvent(new PointerEvent("pointerdown", { clientX: 50, clientY: 50, bubbles: true, button: 0 }));
    window.dispatchEvent(new PointerEvent("pointermove", { clientX: 300, clientY: 200, bubbles: true }));
    window.dispatchEvent(new PointerEvent("pointerup", { clientX: 300, clientY: 200, bubbles: true }));
    await until(() => f.inserts.length > 0);
    expect(f.inserts[0]!.items).toEqual([{ id: note.id, label: "Ellul", picture: false, embed: false }]);
    expect(f.inserts[0]!.at).toEqual({ x: 300, y: 200 });
  });
});

describe("a board's readable page", () => {
  it("writes a capture's card and a picture as embeds, ![[…]], and other cards as links", () => {
    const C = "0192f3a4-7c1e-7b2a-9f00-00000000000c";
    const N = "0192f3a4-7c1e-7b2a-9f00-00000000000d";
    const els: BoardElement[] = [
      { id: "c", type: "embeddable", x: 0, y: 0, link: `librarium://record/${C}`, customData: { librarium: { links: [{ id: C, label: "Technique" }], embed: true } } },
      { id: "n", type: "embeddable", x: 0, y: 100, link: `librarium://record/${N}`, customData: { librarium: { links: [{ id: N, label: "Ellul" }] } } },
    ];
    expect(boardPage("b", els)).toBe(`${boardNote("b")}\n\n![[Technique|${C}]]\n\n[[Ellul|${N}]]\n`);
  });

  it("writes links as [[name|id]]: in a text where their names are, around a linked shape's words, or on a line", () => {
    const A = "0192f3a4-7c1e-7b2a-9f00-00000000000a";
    const B = "0192f3a4-7c1e-7b2a-9f00-00000000000b";
    const els: BoardElement[] = [
      { id: "t", type: "text", x: 0, y: 0, text: "Ellul and Weil, and Ellul", link: `librarium://record/${A}`, customData: { librarium: { links: [{ id: A, label: "Ellul" }, { id: B, label: "Weil" }] } } },
      { id: "box", type: "rectangle", x: 0, y: 100, link: `librarium://record/${B}` },
      { id: "words", type: "text", x: 10, y: 110, text: "Gravity", containerId: "box" },
      { id: "lone", type: "ellipse", x: 0, y: 200, link: `librarium://record/${A}`, customData: { librarium: { links: [{ id: A, label: "Ellul" }] } } },
      { id: "web", type: "ellipse", x: 0, y: 300, link: "https://example.org" },
    ];
    const titles: Record<string, string> = { [A]: "Jacques Ellul", [B]: "Simone | Weil" };
    expect(boardPage("b", els, (id) => titles[id] ?? null)).toBe(
      `${boardNote("b")}

[[Jacques Ellul|${A}]] and [[Simone \\| Weil|${B}]], and Ellul

[[Gravity|${B}]]

[[Jacques Ellul|${A}]]
`,
    );
  });


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
