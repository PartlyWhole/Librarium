/** Capturing, embedding and exporting, against the mock backend with a fake reader view. */
import { describe, expect, it } from "vitest";
import { EditorView } from "@codemirror/view";
import { anchors, exports, mock, mockSegments, mockTexts, seed } from "./mock/backend";
import { createShell, type Shell } from "../src/shell/shell";
import { notes } from "../src/features/notes";
import { library } from "../src/features/library";
import { captures } from "../src/features/captures";
import { READER_TOOLS, type ReaderTool } from "../src/shell/slots";
import type { ReaderView } from "../src/reader/host";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
let last: Shell | null = null;

const PAGE1 = "Technique integrates everything. It avoids shock and sensational events.";
const PAGE2 = "Propaganda is the art of making people act. Technique integrates everything.";

async function boot() {
  last?.destroy();
  mock.reset();
  mock.state.folder = "/lib";
  const src = seed("item", "The Technological Society", "", { "library.format": "pdf" });
  mockTexts.set(src.id, `${PAGE1}\n\n${PAGE2}`);
  mockSegments.set(src.id, [{ label: "p. 1", start: 0, end: [...PAGE1].length }, { label: "p. 2", start: [...PAGE1].length + 2, end: [...PAGE1].length + 2 + [...PAGE2].length }]);
  document.body.innerHTML = '<div id="app"></div>';
  const shell = createShell(document.getElementById("app")!, [notes, library, captures]);
  last = shell;
  await wait(50);
  return { shell, src };
}

function fakeView(sel: { text: string; page: number }): ReaderView {
  return { zoomIn() {}, zoomOut() {}, zoomReset() {}, find: async () => ({ count: 0, current: 0 }), findClear() {}, position: () => "", destroy() {}, selection: () => sel };
}

describe("capturing", () => {
  it("anchors a selection in the stored text, on its page, with W3C selectors", async () => {
    const { shell, src } = await boot();
    const tool = shell.slot<ReaderTool>(READER_TOOLS).get("capture")!;
    const toolbar = document.createElement("div");
    document.body.appendChild(toolbar);
    // "Technique integrates everything." appears on both pages: the selection is on page 2.
    tool.mount(toolbar, { source: shell.records.get(src.id)!, view: fakeView({ text: "Technique integrates everything.", page: 2 }), text: async () => "" });
    (toolbar.querySelector('[aria-label="Capture the selection"]') as HTMLButtonElement).click();
    await wait(30);
    const dialog = document.querySelector("dialog")!;
    expect(dialog.querySelector("blockquote")?.textContent).toBe("Technique integrates everything.");
    (dialog.querySelector("textarea") as HTMLTextAreaElement).value = "Even here.";
    [...dialog.querySelectorAll("button")].find((b) => b.textContent === "Save capture")!.click();
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
  });

  it("collects several parts into one capture", async () => {
    const { shell, src } = await boot();
    const tool = shell.slot<ReaderTool>(READER_TOOLS).get("capture")!;
    const toolbar = document.createElement("div");
    document.body.appendChild(toolbar);
    let sel = { text: "It avoids shock", page: 1 };
    tool.mount(toolbar, { source: shell.records.get(src.id)!, view: { ...fakeView(sel), selection: () => sel }, text: async () => "" });
    (toolbar.querySelector('[aria-label="Capture the selection"]') as HTMLButtonElement).click();
    await wait(30);
    [...document.querySelectorAll("dialog button")].find((b) => b.textContent === "Add another part")!.dispatchEvent(new MouseEvent("click"));
    await wait(10);
    expect(toolbar.querySelector(".tray")?.textContent).toBe("1 part · Save…");
    sel = { text: "the art of making people act", page: 2 };
    (toolbar.querySelector('[aria-label="Capture the selection"]') as HTMLButtonElement).click();
    await wait(30);
    [...document.querySelectorAll("dialog button")].find((b) => b.textContent === "Save capture")!.dispatchEvent(new MouseEvent("click"));
    await wait(30);
    const cap = shell.records.list("capture")[0]!;
    expect(cap.fields["captures.parts"]).toBe(2);
    expect(cap.fields["captures.quote"]).toBe("It avoids shock … the art of making people act");
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
    expect(embed.querySelector("figcaption")?.textContent).toBe("— The Technological Society, p. 1");

    mock.state.savePath = "/Users/me/Desktop/Essay.md";
    shell.actions.run("notes.exportWithQuotations");
    await wait(30);
    expect(exports.get("/Users/me/Desktop/Essay.md")).toBe("Ellul writes:\n\n> It avoids shock and sensational events.\n>\n> — The Technological Society, p. 1\n\nand so on.\n");
  });
});

describe("the captures panel", () => {
  it("says when a capture has moved in its source", async () => {
    const { shell, src } = await boot();
    const tool = shell.slot<ReaderTool>(READER_TOOLS).get("capture")!;
    const toolbar = document.createElement("div");
    tool.mount(toolbar, { source: shell.records.get(src.id)!, view: fakeView({ text: "It avoids shock and sensational events.", page: 1 }), text: async () => "" });
    (toolbar.querySelector('[aria-label="Capture the selection"]') as HTMLButtonElement).click();
    await wait(30);
    [...document.querySelectorAll("dialog button")].find((b) => b.textContent === "Save capture")!.dispatchEvent(new MouseEvent("click"));
    await wait(30);
    // The source's text is re-extracted with small differences.
    mockTexts.set(src.id, `${PAGE1.replace("sensational", "sensationnal")}\n\n${PAGE2}`);
    shell.router.go("item", { id: src.id });
    shell.actions.run("shell.toggleSidePanel");
    await wait(80);
    expect(document.querySelector(".side-panel .badge.moved")?.textContent).toBe("moved");
  });
});
