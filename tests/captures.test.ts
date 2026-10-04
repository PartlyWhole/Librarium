/** Capturing, embedding and exporting, against the mock backend with a fake reader view. */
import { describe, expect, it } from "vitest";
import { EditorView } from "@codemirror/view";
import { anchors, exports, mock, mockSegments, mockTexts, seed } from "./mock/backend";
import { createShell, type Shell } from "../src/shell/shell";
import { notes } from "../src/features/notes";
import { library } from "../src/features/library";
import { captures } from "../src/features/captures";
import { archive } from "../src/features/archive";
import { READER_TOOLS, type ReaderTool } from "../src/shell/slots";
import type { Mark, ReaderView } from "../src/reader/host";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
let last: Shell | null = null;

const PAGE1 = "Technique integrates everything. It avoids shock and sensational events.";
const PAGE2 = "Propaganda is the art of making people act. Technique integrates everything.";

async function boot(withArchive = false) {
  last?.destroy();
  mock.reset();
  mock.state.folder = "/lib";
  const src = seed("item", "The Technological Society", "", { "library.format": "pdf" });
  mockTexts.set(src.id, `${PAGE1}\n\n${PAGE2}`);
  mockSegments.set(src.id, [{ label: "p. 1", start: 0, end: [...PAGE1].length }, { label: "p. 2", start: [...PAGE1].length + 2, end: [...PAGE1].length + 2 + [...PAGE2].length }]);
  document.body.innerHTML = '<div id="app"></div>';
  const shell = createShell(document.getElementById("app")!, withArchive ? [notes, library, captures, archive] : [notes, library, captures]);
  last = shell;
  await wait(50);
  return { shell, src };
}

type Sel = { text: string; page: number; boxes?: { page: number; x: number; y: number; w: number; h: number }[]; end?: { x: number; y: number; bottom: number } };

/** A reader view that hands out the given selection, and records marks and watchers. */
function fakeView(get: () => Sel | null, extra: Partial<ReaderView> = {}) {
  const watchers: (() => void)[] = [];
  const marks: { current: Mark[] } = { current: [] };
  const markClicks: ((ids: string[], at: { x: number; y: number }) => void)[] = [];
  const view: ReaderView = {
    zoomIn() {}, zoomOut() {}, zoomReset() {}, find: async () => ({ count: 0, current: 0 }), findClear() {}, position: () => "", destroy() {},
    selection: () => get(),
    watchSelection: (cb) => (watchers.push(cb), () => {}),
    clearSelection() {},
    setMarks: (m) => (marks.current = m),
    onMarkClick: (cb) => (markClicks.push(cb), () => {}),
    ...extra,
  };
  return { view, marks, select: () => watchers.forEach((w) => w()), clickMark: (ids: string[]) => markClicks.forEach((cb) => cb(ids, { x: 100, y: 100 })) };
}

function mountTool(shell: Shell, src: { id: string }, view: ReaderView) {
  const tool = shell.slot<ReaderTool>(READER_TOOLS).get("capture")!;
  const toolbar = document.createElement("div");
  const aside = document.createElement("aside");
  document.body.append(toolbar, aside);
  const dispose = tool.mount(toolbar, { source: shell.records.get(src.id)!, view, text: async () => "", aside }) as () => void;
  return { toolbar, aside, dispose, capture: () => (toolbar.querySelector('[aria-label="Capture the selection"]') as HTMLButtonElement).click() };
}

const button = (root: ParentNode, text: string) => [...root.querySelectorAll("button")].find((b) => b.textContent === text) as HTMLButtonElement;

describe("capturing", () => {
  it("anchors a selection in the stored text, on its page, with W3C selectors", async () => {
    const { shell, src } = await boot();
    // "Technique integrates everything." appears on both pages: the selection is on page 2.
    const { view } = fakeView(() => ({ text: "Technique integrates everything.", page: 2 }));
    const t = mountTool(shell, src, view);
    t.capture();
    await wait(30);
    // No dialog: the capture waits in the panel beside the document.
    expect(document.querySelector("dialog")).toBeNull();
    expect(t.aside.querySelector("blockquote")?.textContent).toBe("Technique integrates everything.");
    (t.aside.querySelector("textarea") as HTMLTextAreaElement).value = "Even here.";
    t.aside.querySelector("textarea")!.dispatchEvent(new Event("input"));
    button(t.aside, "Save capture").click();
    await wait(30);
    const cap = shell.records.list("capture")[0]!;
    expect(cap.fields["captures.locator"]).toBe("p. 2");
    const a = anchors.get(cap.id);
    const quote = a.parts[0].selector.find((s: { type: string }) => s.type === "TextQuoteSelector");
    const pos = a.parts[0].selector.find((s: { type: string }) => s.type === "TextPositionSelector");
    const page = a.parts[0].selector.find((s: { type: string }) => s.type === "FragmentSelector");
    expect(quote.exact).toBe("Technique integrates everything.");
    expect(quote.prefix.endsWith("art of making people act. ")).toBe(true);
    expect(pos.start).toBe([...PAGE1].length + 2 + PAGE2.indexOf("Technique"));
    expect(page.value).toBe("page=2");
    expect(t.aside.querySelector(".capture-draft")).toBeNull();
  });

  it("collects several parts into one capture, in the source's order, each shown and highlighted", async () => {
    const { shell, src } = await boot();
    let sel: Sel | null = { text: "the art of making people act", page: 2, boxes: [{ page: 2, x: 10, y: 20, w: 50, h: 2 }] };
    const f = fakeView(() => sel);
    const t = mountTool(shell, src, f.view);
    // Picked out of order: page 2 first, then page 1.
    t.capture();
    await wait(30);
    sel = { text: "It avoids shock", page: 1, boxes: [{ page: 1, x: 10, y: 5, w: 20, h: 2 }] };
    t.capture();
    await wait(30);
    const quotes = [...t.aside.querySelectorAll("blockquote")].map((q) => q.textContent);
    expect(quotes).toEqual(["It avoids shock", "the art of making people act"]);
    expect(t.aside.querySelector(".draft-gap")?.textContent).toBe("[…]");
    expect(t.aside.textContent).toContain("2 parts");
    // Both are highlighted in the document while the capture is being made.
    expect(f.marks.current.flatMap((m) => m.boxes.map((b) => b.page))).toEqual([1, 2]);
    // A third part, then removed again.
    sel = { text: "Propaganda", page: 2, boxes: [{ page: 2, x: 0, y: 1, w: 9, h: 2 }] };
    t.capture();
    await wait(30);
    expect(t.aside.querySelectorAll("blockquote")).toHaveLength(3);
    (t.aside.querySelectorAll('[aria-label="Remove this part"]')[1] as HTMLButtonElement).click();
    await wait(10);
    expect([...t.aside.querySelectorAll("blockquote")].map((q) => q.textContent)).toEqual(["It avoids shock", "the art of making people act"]);
    button(t.aside, "Save capture").click();
    await wait(30);
    const cap = shell.records.list("capture")[0]!;
    expect(cap.fields["captures.parts"]).toBe(2);
    expect(cap.fields["captures.quote"]).toBe("It avoids shock […] the art of making people act");
    // Once saved, both parts stay highlighted, as a saved capture.
    expect(f.marks.current.map((m) => [m.saved, m.boxes[0]?.page])).toEqual([[true, 1], [true, 2]]);
  });

  it("offers a button by the selection: Capture, then Add to capture", async () => {
    const { shell, src } = await boot();
    let sel: Sel | null = { text: "It avoids shock", page: 1, end: { x: 200, y: 100, bottom: 118 } };
    const f = fakeView(() => sel);
    const t = mountTool(shell, src, f.view);
    const pop = () => document.querySelector(".selection-pop") as HTMLElement;
    f.select();
    expect(pop().hidden).toBe(false);
    expect(pop().textContent).toBe("Capture");
    pop().querySelector("button")!.click();
    await wait(30);
    expect(pop().hidden).toBe(true);
    expect(t.aside.querySelectorAll("blockquote")).toHaveLength(1);
    sel = { text: "the art of making people act", page: 2, end: { x: 200, y: 300, bottom: 318 } };
    f.select();
    expect(pop().textContent).toBe("Add to capture");
    // Clearing the selection hides it.
    sel = null;
    f.select();
    expect(pop().hidden).toBe(true);
    t.dispose();
    expect(document.querySelector(".selection-pop")).toBeNull();
  });

  it("captures a region, with its picture, alongside text", async () => {
    const { shell, src } = await boot();
    const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const f = fakeView(() => ({ text: "It avoids shock", page: 1 }), { pickRegion: async () => ({ page: 2, x: 10, y: 40, w: 30, h: 20, png }) });
    const t = mountTool(shell, src, f.view);
    (t.toolbar.querySelector('[aria-label="Capture a region"]') as HTMLButtonElement).click();
    await wait(30);
    t.capture();
    await wait(30);
    expect(t.aside.querySelector("img.capture-region")?.getAttribute("src")).toBe(png);
    expect(f.marks.current.find((m) => m.region)?.boxes[0]).toEqual({ page: 2, x: 10, y: 40, w: 30, h: 20 });
    button(t.aside, "Save capture").click();
    await wait(30);
    const cap = shell.records.list("capture")[0]!;
    expect(cap.fields["captures.parts"]).toBe(2);
    const a = anchors.get(cap.id);
    // The text on page 1 comes before the region on page 2.
    expect(a.parts[0].selector[0].type).toBe("TextQuoteSelector");
    expect(a.parts[1].selector[0].refinedBy.value).toBe("xywh=percent:10,40,30,20");
  });

  it("keeps the capture being made when the item is left and opened again", async () => {
    const { shell, src } = await boot();
    const f = fakeView(() => ({ text: "It avoids shock", page: 1 }));
    const t = mountTool(shell, src, f.view);
    t.capture();
    await wait(30);
    t.aside.querySelector("textarea")!.value = "Keep this.";
    t.aside.querySelector("textarea")!.dispatchEvent(new Event("input"));
    t.dispose();
    const again = mountTool(shell, src, fakeView(() => null).view);
    await wait(10);
    expect(again.aside.querySelector("blockquote")?.textContent).toBe("It avoids shock");
    expect(again.aside.querySelector("textarea")?.value).toBe("Keep this.");
    button(again.aside, "Discard").click();
    await wait(10);
    expect(again.aside.querySelector(".capture-draft")).toBeNull();
  });
});

describe("saved captures in the reader", () => {
  it("are highlighted softly where they were made, again on reopening, and open from a click", async () => {
    const { shell, src } = await boot();
    const sel: Sel = { text: "It avoids shock", page: 1, boxes: [{ page: 1, x: 10, y: 5, w: 20, h: 2 }] };
    const f = fakeView(() => sel);
    const t = mountTool(shell, src, f.view);
    t.capture();
    await wait(30);
    button(t.aside, "Save capture").click();
    await wait(60);
    const cap = shell.records.list("capture")[0]!;
    // The anchor keeps where the part was drawn.
    expect(anchors.get(cap.id).parts[0].boxes).toEqual([{ page: 1, x: 10, y: 5, w: 20, h: 2 }]);
    // Drawn as saved, no longer as being made.
    expect(f.marks.current).toEqual([{ id: `${cap.id}#0`, boxes: [{ page: 1, x: 10, y: 5, w: 20, h: 2 }], region: false, cfi: undefined, saved: true }]);
    t.dispose();
    // Opened again: there.
    const g = fakeView(() => null);
    const again = mountTool(shell, src, g.view);
    await wait(30);
    expect(g.marks.current.map((m) => m.id)).toEqual([`${cap.id}#0`]);
    // A click on it offers to open it.
    g.clickMark([`${cap.id}#0`]);
    const pops = [...document.querySelectorAll(".selection-pop")].filter((p) => !(p as HTMLElement).hidden);
    expect(pops.map((p) => [...p.querySelectorAll("button")].map((b) => b.textContent))).toEqual([["Open capture", "Delete"]]);
    (pops[0]!.querySelector("button") as HTMLButtonElement).click();
    await wait(30);
    expect(shell.router.current()).toMatchObject({ page: "capture", params: { id: cap.id } });
    // Archived, it isn't highlighted any more.
    await (await import("./mock/backend")).call("archive.archive", { id: cap.id });
    shell.hidingFields.add("test", "archive.at", "archive.at");
    await shell.records.load();
    await wait(30);
    expect(g.marks.current).toEqual([]);
    again.dispose();
  });
});

describe("embeds", () => {
  it("show as the quotation with its citation, and export written out", async () => {
    const { shell, src } = await boot();
    const cap = seed("capture", "It avoids shock and…", "", { "captures.source": src.id, "captures.quote": "It avoids shock and sensational events.", "captures.locator": "p. 1", "captures.parts": 1 });
    const n = seed("note", "Essay", `Ellul writes:\n\n![[It avoids shock and…|${cap.id}]]\n\nand so on.\n`);
    await shell.records.load();
    shell.router.go("note", { id: n.id });
    await wait(60);
    const view = EditorView.findFromDOM(document.querySelector(".cm-editor") as HTMLElement)!;
    view.dispatch({ selection: { anchor: view.state.doc.length } });
    const embed = view.contentDOM.querySelector(".embed")!;
    expect(embed.querySelector("blockquote")?.textContent).toBe("It avoids shock and sensational events.");
    expect(embed.querySelector(".embed-cite")?.textContent).toBe("— The Technological Society, p. 1");
    // Edit opens the capture.
    (embed.querySelector(".embed-edit") as HTMLButtonElement).click();
    await wait(30);
    expect(shell.router.current()).toMatchObject({ page: "capture", params: { id: cap.id } });
    shell.router.go("note", { id: n.id });
    await wait(60);

    mock.state.savePath = "/Users/me/Desktop/Essay.md";
    shell.actions.run("notes.exportWithQuotations");
    await wait(30);
    expect(exports.get("/Users/me/Desktop/Essay.md")).toBe("Ellul writes:\n\n> It avoids shock and sensational events.\n>\n> — The Technological Society, p. 1\n\nand so on.\n");
  });
});

describe("the captures panel", () => {
  it("says when a capture has moved in its source", async () => {
    const { shell, src } = await boot();
    const t = mountTool(shell, src, fakeView(() => ({ text: "It avoids shock and sensational events.", page: 1 })).view);
    t.capture();
    await wait(30);
    button(t.aside, "Save capture").click();
    await wait(30);
    t.dispose();
    // The source's text is re-extracted with small differences.
    mockTexts.set(src.id, `${PAGE1.replace("sensational", "sensationnal")}\n\n${PAGE2}`);
    shell.router.go("item", { id: src.id });
    // The panel shows one view at a time: its Captures view.
    shell.showPanelSection("captures");
    await wait(80);
    expect(document.querySelector(".side-panel .badge.moved")?.textContent).toBe("moved");
  });
});

describe("editing and deleting captures", () => {
  it("deletes from a highlight's popover: the capture goes to the archive, with Undo", async () => {
    const { shell, src } = await boot(true);
    const f = fakeView(() => ({ text: "It avoids shock", page: 1, boxes: [{ page: 1, x: 10, y: 5, w: 20, h: 2 }] }));
    const t = mountTool(shell, src, f.view);
    t.capture();
    await wait(30);
    button(t.aside, "Save capture").click();
    await wait(60);
    const cap = shell.records.list("capture")[0]!;
    f.clickMark([`${cap.id}#0`]);
    const pop = [...document.querySelectorAll(".selection-pop")].find((p) => !(p as HTMLElement).hidden)!;
    button(pop, "Delete").click();
    await wait(60);
    expect(shell.records.get(cap.id)?.fields["archive.at"]).toBeTruthy();
    expect(f.marks.current).toEqual([]);
    expect(document.body.textContent).toContain("Undo");
    t.dispose();
  });

  it("renames on the capture page (the quote stays exact), and deletes from its header", async () => {
    const { shell, src } = await boot(true);
    const cap = seed("capture", "It avoids shock and…", "Why it matters.", { "captures.source": src.id, "captures.quote": "It avoids shock and sensational events.", "captures.locator": "p. 1", "captures.parts": 1 });
    anchors.set(cap.id, { id: cap.id, source: src.id, snapshot: null, parts: [{ selector: [{ type: "TextQuoteSelector", exact: "It avoids shock and sensational events.", prefix: "", suffix: "" }] }] });
    await shell.records.load();
    shell.router.go("item", { id: src.id });
    shell.router.go("capture", { id: cap.id });
    await wait(80);
    const title = document.querySelector(".title-input") as HTMLInputElement;
    expect(title.value).toBe("It avoids shock and…");
    title.value = "On technique";
    title.dispatchEvent(new Event("blur"));
    await wait(60);
    expect(shell.records.get(cap.id)?.title).toBe("On technique");
    expect(document.querySelector(".capture-quote")?.textContent).toBe("It avoids shock and sensational events.");
    (document.querySelector('[aria-label="Delete capture"]') as HTMLButtonElement).click();
    await wait(80);
    expect(shell.records.get(cap.id)?.fields["archive.at"]).toBeTruthy();
  });

  it("offers Open, Show in the source, Copy embed and Delete on a capture in the Library", async () => {
    const { shell, src } = await boot(true);
    const cap = seed("capture", "It avoids shock and…", "", { "captures.source": src.id, "captures.quote": "It avoids shock and sensational events.", "captures.parts": 1 });
    await shell.records.load();
    const children = shell.slot<{ children(item: unknown): { id: string; onContext?: (at: { x: number; y: number }) => void }[] }>("library.item-children").get("captures")!.children(shell.records.get(src.id));
    expect(children.map((c) => c.id)).toEqual([cap.id]);
    children[0]!.onContext!({ x: 10, y: 10 });
    const items = [...document.querySelectorAll(".context-menu [role=menuitem]")];
    expect(items.map((i) => i.textContent)).toEqual(["Open", "Show in the source", "Copy embed", "Delete"]);
    (items[3] as HTMLElement).click();
    await wait(60);
    expect(shell.records.get(cap.id)?.fields["archive.at"]).toBeTruthy();
    // Archived, it no longer shows under its source; a note embedding it says where it is.
    const after = shell.slot<{ children(item: unknown): unknown[] }>("library.item-children").get("captures")!.children(shell.records.get(src.id));
    expect(after).toEqual([]);
    const n = seed("note", "Essay", `![[It avoids shock and…|${cap.id}]]\n\nand so on.\n`);
    await shell.records.load();
    shell.router.go("note", { id: n.id });
    await wait(60);
    const view = EditorView.findFromDOM(document.querySelector(".cm-editor") as HTMLElement)!;
    view.dispatch({ selection: { anchor: view.state.doc.length } });
    expect(view.contentDOM.querySelector(".embed .badge")?.textContent).toBe("In the archive");
  });
});
