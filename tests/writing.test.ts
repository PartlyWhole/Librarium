import { EditorView } from "@codemirror/view";
/** Writing comfort: word counts, the outline, and making a note from an unresolved link. */
import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { markdownSupport } from "../src/editor/markdown";
import { countText, outline } from "../src/editor/stats";
import { mock, seed } from "./mock/backend";
import { createShell, type Shell } from "../src/shell/shell";
import { notes } from "../src/features/notes";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ID = "0192f3a4-7c1e-7b2a-9f00-000000000002";

describe("counts and outline", () => {
  it("count what a reader sees: link labels, not IDs or addresses or marks", () => {
    expect(countText(`# Title\n\n**Two** words and [[Simone Weil|${ID}]] and [an essay](https://e.org/x).\n\n- [ ] a task`)).toEqual({ words: 11, chars: 42 });
  });

  it("lists headings in order, with their level", () => {
    const state = EditorState.create({ doc: "# One\n\ntext\n\n## Two **bold**\n\n### Three", extensions: [markdownSupport()] });
    expect(outline(state).map((h) => [h.level, h.text])).toEqual([[1, "One"], [2, "Two bold"], [3, "Three"]]);
  });
});

describe("a note page", () => {
  let last: Shell | null = null;
  async function open(body: string) {
    last?.destroy();
    mock.reset();
    mock.state.folder = "/lib";
    const n = seed("note", "Draft", body, {}, "Essays");
    document.body.innerHTML = '<div id="app"></div>';
    const shell = createShell(document.getElementById("app")!, [notes]);
    last = shell;
    await wait(60);
    shell.openRecord(n.id);
    await wait(60);
    return { shell, n };
  }

  it("shows its words in the status bar while it is shown", async () => {
    const { shell } = await open("Three little words.\n");
    expect(shell.status.context()).toBe("3 words · 17 characters");
    expect(document.querySelector(".status-right")?.textContent).toContain("3 words");
    shell.router.newTab();
    await wait(20);
    expect(shell.status.context()).toBe("");
  });

  it("makes a note when an unresolved link is clicked, beside this one, and links to it", async () => {
    const { shell, n } = await open("See [[New idea]] later.\n");
    const link = document.querySelector<HTMLElement>(".cm-wikilink.unresolved")!;
    expect(link.textContent).toBe("New idea");
    link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await wait(60);
    const made = shell.records.list("note").find((r) => r.title === "New idea")!;
    expect(made).toBeDefined();
    expect(made.path).toMatch(/^notes\/Essays\//);
    expect(shell.router.current()).toEqual({ page: "note", params: { id: made.id } });
    // The link in the first note now carries the ID (saved when the page closed).
    await wait(50);
    const saved = mock.state.records.get(n.id)!.body;
    expect(saved).toContain(`[[New idea|${made.id}]]`);
  });

  it("makes the note on ⌘-click of an unresolved link being edited", async () => {
    const { shell } = await open("See [[Other idea]]\n");
    const view = EditorView.findFromDOM(document.querySelector(".cm-editor") as HTMLElement)!;
    view.dispatch({ selection: { anchor: 10 } });
    const src = document.querySelector<HTMLElement>(".cm-wikilink-source")!;
    src.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, metaKey: true }));
    await wait(60);
    const made = shell.records.list("note").find((r) => r.title === "Other idea")!;
    expect(made).toBeDefined();
    expect(shell.router.current()).toEqual({ page: "note", params: { id: made.id } });
  });

  it("offers an outline of its headings in the side panel", async () => {
    const { shell } = await open("# Part one\n\ntext\n\n## A section\n");
    shell.actions.run("shell.toggleSidePanel");
    await wait(30);
    const links = [...document.querySelectorAll(".outline-link")].map((b) => b.textContent);
    expect(links).toEqual(["Part one", "A section"]);
  });
});
