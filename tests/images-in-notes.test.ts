/** Images in notes are library items (R-021): pasted or dropped, stored, embedded, shown. */
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
    const item = shell.records.list("item").find((r) => r.title === "chart")!;
    expect(item).toBeDefined();
    // The note now embeds it, on its own line.
    await wait(1100);
    expect(mock.state.records.get(n.id)!.body).toContain(`![[chart|${item.id}]]`);
  });
});
