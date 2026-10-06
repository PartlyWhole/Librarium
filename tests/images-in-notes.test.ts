/** Images in notes are library items (R-021), kept in Attachments (R-042): pasted or dropped, stored, embedded, shown. */
import { describe, expect, it } from "vitest";
import { mock, seed } from "./mock/backend";
import { createShell } from "../src/shell/shell";
import { notes } from "../src/features/notes";
import { library } from "../src/features/library";
import { captures } from "../src/features/captures";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("images in notes", () => {
  it("a pasted image becomes a library item, embedded in the note where it was pasted", async () => {
    mock.reset();
    mock.state.folder = "/lib";
    const n = seed("note", "Draft", "Before.\n");
    document.body.innerHTML = '<div id="app"></div>';
    const shell = createShell(document.getElementById("app")!, [notes, library, captures]);
    await wait(60);
    shell.openRecord(n.id);
    await wait(60);
    const content = document.querySelector<HTMLElement>(".ws-page:not([hidden]) .cm-content")!;
    const file = new File([new Uint8Array([137, 80, 78, 71])], "chart.png", { type: "image/png" });
    const paste = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(paste, "clipboardData", { value: { files: [file], getData: () => "" } });
    content.dispatchEvent(paste);
    await wait(80);
    const call = mock.state.calls.find((c) => c.method === "library.importData");
    expect((call?.params as { name: string }).name).toBe("chart.png");
    // Kept in the Library's Attachments folder (R-042).
    expect((call?.params as { folder?: string }).folder).toBe("Attachments");
    const item = shell.records.list("item").find((r) => r.title === "chart")!;
    expect(item).toBeDefined();
    expect(item.path).toMatch(/^items\/Attachments\//);
    expect(shell.status.message()).toContain("Attached “chart”");
    // The note now embeds it, on its own line.
    await wait(1100);
    expect(mock.state.records.get(n.id)!.body).toContain(`![[chart|${item.id}]]`);
    // Promoted to a standalone item: out of Attachments, to the Library's top; Undo puts it back.
    const acts = shell.recordActionsFor([item]);
    const promote = acts.find((a) => a.label === "Move to the Library")!;
    expect(promote).toBeDefined();
    promote.run();
    await wait(60);
    const moved = shell.records.get(item.id)!;
    expect(moved.path).toMatch(/^items\/[^/]+\/record\.json$/);
    expect(shell.recordActionsFor([moved]).some((a) => a.label === "Move to the Library")).toBe(false);
    // The note still shows it (it points at the ID).
    expect(mock.state.records.get(n.id)!.body).toContain(`![[chart|${item.id}]]`);
    await shell.undo.undoLast();
    await wait(60);
    expect(shell.records.get(item.id)!.path).toMatch(/^items\/Attachments\//);
  });
});

describe("resizing images in notes (R-067, decision 0071)", () => {
  it("keeps a width after the embed, set from the picture's corner", async () => {
    mock.reset();
    mock.state.folder = "/lib";
    const pic = seed("item", "chart", "", { "library.format": "image", "library.original": "chart.png" });
    const n = seed("note", "Draft", `Before.\n\n![[chart|${pic.id}]]{width=200}\n\nAfter.\n`);
    document.body.innerHTML = '<div id="app"></div>';
    const shell = createShell(document.getElementById("app")!, [notes, library, captures]);
    await wait(60);
    shell.openRecord(n.id);
    await wait(80);
    const page = () => document.querySelector<HTMLElement>(".ws-page:not([hidden])")!;
    const figure = () => page().querySelector<HTMLElement>(".cm-embed.embed-figure")!;
    // Drawn at that width, the attribute hidden with the embed.
    expect(figure().style.width).toBe("200px");
    expect(figure().classList.contains("embed-sized")).toBe(true);
    expect(page().querySelector(".cm-content")!.textContent).not.toContain("{width=");
    const handle = () => figure().querySelector<HTMLElement>(".embed-resize[role=slider]")!;
    expect(handle().getAttribute("aria-label")).toBe("Width of chart");
    // The keys: Home is the smallest; End the picture's own size (no width kept).
    handle().dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true }));
    await wait(1100);
    expect(mock.state.records.get(n.id)!.body).toContain(`![[chart|${pic.id}]]{width=48}\n`);
    handle().dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
    await wait(1100);
    expect(mock.state.records.get(n.id)!.body).toContain(`![[chart|${pic.id}]]\n\nAfter.`);
    expect(figure().classList.contains("embed-sized")).toBe(false);
    expect(figure().style.width).toBe("");
    // A width given again replaces the one kept, never adds a second.
    handle().dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true }));
    handle().dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true }));
    await wait(1100);
    expect(mock.state.records.get(n.id)!.body.match(/\{width=/g)?.length).toBe(1);
    // Double-click: its own size again.
    handle().dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    await wait(1100);
    expect(mock.state.records.get(n.id)!.body).not.toContain("{width=");
    shell.destroy();
  });
});

describe("⌘-click on an item shown in a note (R-068)", () => {
  it("opens it in a new tab, as captures and links do; a plain click opens it here", async () => {
    mock.reset();
    mock.state.folder = "/lib";
    const pic = seed("item", "chart", "", { "library.format": "image", "library.original": "chart.png" });
    const page = seed("item", "An article", "", { "library.format": "web" });
    const n = seed("note", "Draft", `Top.\n\n![[chart|${pic.id}]]\n\n![[An article|${page.id}]]\n\nAfter.\n`);
    document.body.innerHTML = '<div id="app"></div>';
    const shell = createShell(document.getElementById("app")!, [notes, library, captures]);
    await wait(60);
    shell.openRecord(n.id);
    await wait(80);
    const embeds = () => [...document.querySelectorAll<HTMLElement>(".ws-page:not([hidden]) .cm-embed")];
    embeds()[0]!.querySelector("img")!.dispatchEvent(new MouseEvent("click", { bubbles: true, metaKey: true }));
    await wait(30);
    expect(shell.router.tabs().length).toBe(2);
    shell.router.select(0);
    await wait(30);
    embeds()[1]!.querySelector("a")!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, metaKey: true }));
    await wait(30);
    expect(shell.router.tabs().length).toBe(3);
    shell.router.select(0);
    await wait(30);
    embeds()[1]!.querySelector("a")!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await wait(30);
    expect(shell.router.tabs().length).toBe(3);
    expect(shell.router.current.peek().params.id).toBe(page.id);
    shell.destroy();
  });
});
