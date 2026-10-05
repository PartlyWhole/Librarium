/** Indentation is indentation (decision 0058): not code; Tab indents; links and captures follow. */
import { describe, expect, it } from "vitest";
import { EditorView } from "@codemirror/view";
import { indentMore } from "@codemirror/commands";
import { mock, seed } from "./mock/backend";
import { createShell, type Shell } from "../src/shell/shell";
import { notes } from "../src/features/notes";
import { indentColumns } from "../src/editor/indent";
import { parseLinks } from "../src/editor/links";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ID = "0192f3a4-7c1e-7b2a-9f00-000000000002";

let last: Shell | null = null;
async function open(body: string) {
  last?.destroy();
  mock.reset();
  mock.state.folder = "/lib";
  const target = seed("note", "Simone Weil", "");
  const n = seed("note", "Draft", body.replaceAll(ID, target.id));
  document.body.innerHTML = '<div id="app"></div>';
  const shell = createShell(document.getElementById("app")!, [notes]);
  last = shell;
  await wait(50);
  shell.router.go("note", { id: n.id });
  await wait(60);
  const view = EditorView.findFromDOM(document.querySelector(".cm-editor") as HTMLElement)!;
  return { shell, view, target };
}

describe("indentation", () => {
  it("counts columns with tabs stopping every four", () => {
    expect(indentColumns("\t")).toBe(4);
    expect(indentColumns("  \t")).toBe(4);
    expect(indentColumns("\t\t ")).toBe(9);
  });

  it("an indented link is a link, not code", () => {
    expect(parseLinks(`Para.\n\n\t\t> [[Weil|${ID}]]\n`)).toHaveLength(1);
  });

  it("Tab on a line that isn't a list item indents it with a tab", async () => {
    const { view } = await open("A line.\n");
    view.dispatch({ selection: { anchor: 3 } });
    indentMore(view);
    expect(view.state.doc.line(1).text).toBe("\tA line.");
  });

  it("away from the cursor, an indented line shows its link, moved right by a margin", async () => {
    const { view, target } = await open(`First.\n\n\t\t> See [[Weil|${ID}]]\n\nLast.`);
    view.dispatch({ selection: { anchor: view.state.doc.length } });
    const line = [...view.contentDOM.querySelectorAll<HTMLElement>(".cm-line")].find((l) => l.textContent?.includes("Weil"))!;
    expect(line.querySelector(".cm-wikilink")?.getAttribute("data-id")).toBe(target.id);
    expect(line.style.marginLeft).toMatch(/em$/);
    expect(line.textContent?.startsWith("\t")).toBe(false);
    // On the line being edited the tabs show as typed, and nothing is code.
    view.dispatch({ selection: { anchor: view.state.doc.line(3).from + 2 } });
    const editing = [...view.contentDOM.querySelectorAll<HTMLElement>(".cm-line")].find((l) => l.textContent?.includes("Weil"))!;
    expect(editing.querySelector(".cm-indent")?.textContent).toBe("\t\t");
    expect(view.contentDOM.querySelector(".cm-code-block")).toBeNull();
  });

  it("fenced code keeps its indentation as typed", async () => {
    const { view } = await open("```\n\tcode\n```\n\nEnd.");
    view.dispatch({ selection: { anchor: view.state.doc.length } });
    expect(view.contentDOM.querySelector(".cm-indent")).toBeNull();
    const code = [...view.contentDOM.querySelectorAll<HTMLElement>(".cm-line")].find((l) => l.textContent?.includes("code"))!;
    expect(code.style.marginLeft).toBe("");
  });
});
