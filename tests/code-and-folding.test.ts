/** Code blocks are highlighted by language; headings fold and unfold. */
import { describe, expect, it } from "vitest";
import { EditorSelection } from "@codemirror/state";
import { foldCode, unfoldCode, foldedRanges, ensureSyntaxTree } from "@codemirror/language";
import { createEditor } from "../src/editor/editor";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function editor(doc: string) {
  const parent = document.createElement("div");
  document.body.replaceChildren(parent);
  return createEditor({ parent, doc, label: "Note", targets: () => [], open: () => {}, titleOf: () => null });
}

describe("code and folding", () => {
  it("highlights a fenced block in its language (loaded when needed)", async () => {
    const v = editor("Text\n\n```js\nconst a = \"hi\";\n```\n");
    for (let i = 0; i < 40 && !v.contentDOM.querySelector(".cm-code-block .tok-keyword"); i++) {
      await wait(25);
      ensureSyntaxTree(v.state, v.state.doc.length, 200);
      v.dispatch({});
    }
    expect(v.contentDOM.querySelector(".cm-code-block .tok-keyword")?.textContent).toBe("const");
    expect(v.contentDOM.querySelector(".cm-code-block .tok-string")?.textContent).toBe('"hi"');
  });

  it("folds a heading's section and unfolds it, without changing the text", () => {
    const doc = "# One\n\nalpha\n\nbeta\n\n# Two\n\ngamma";
    const v = editor(doc);
    v.dispatch({ selection: EditorSelection.cursor(2) });
    ensureSyntaxTree(v.state, v.state.doc.length, 200);
    expect(foldCode(v)).toBe(true);
    let n = 0;
    foldedRanges(v.state).between(0, v.state.doc.length, () => void n++);
    expect(n).toBe(1);
    expect(v.contentDOM.textContent).not.toContain("beta");
    expect(v.state.doc.toString()).toBe(doc);
    unfoldCode(v);
    expect(v.contentDOM.textContent).toContain("beta");
  });
});
