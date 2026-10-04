/** Pasting HTML as Markdown; copying links without their IDs for other apps. */
import { describe, expect, it } from "vitest";
import { htmlToMarkdown } from "../src/editor/html2md";
import { withoutIds } from "../src/editor/clipboard";

describe("pasted HTML", () => {
  it("becomes Markdown: headings, emphasis, links, lists, quotes, code, tables, images", () => {
    const html = `<h2>On <em>technique</em></h2>
      <p>Some <strong>bold</strong> and <b>more</b>, <i>slant</i>, <del>gone</del>, <mark>lit</mark>, <code>x = 1</code>, a <a href="https://e.org/a">link</a> and <a href="https://e.org">https://e.org</a>.</p>
      <ul><li>one</li><li>two<ul><li>nested</li></ul></li><li><input type="checkbox" checked> done</li></ul>
      <ol start="3"><li>three</li><li>four</li></ol>
      <blockquote><p>Quoted.</p><p>Twice.</p></blockquote>
      <pre><code class="language-js">let a = 1;
a++;</code></pre>
      <table><tr><th>A</th><th>B|C</th></tr><tr><td>1</td><td>2</td></tr></table>
      <p><img src="https://e.org/i.png" alt="a chart"></p><hr><script>alert(1)</script>`;
    expect(htmlToMarkdown(html)).toBe(
      [
        "## On *technique*",
        "Some **bold** and **more**, *slant*, ~~gone~~, ==lit==, `x = 1`, a [link](https://e.org/a) and <https://e.org>.",
        "- one\n- two\n  - nested\n- [x] done",
        "3. three\n4. four",
        "> Quoted.\n>\n> Twice.",
        "```js\nlet a = 1;\na++;\n```",
        "| A | B\\|C |\n| --- | --- |\n| 1 | 2 |",
        "![a chart](https://e.org/i.png)",
        "---",
      ].join("\n\n"),
    );
  });

  it("escapes text that would otherwise turn into markup", () => {
    expect(htmlToMarkdown("<p>2 * 3 = [six]</p><p># not a heading</p>")).toBe("2 \\* 3 = \\[six\\]\n\n\\# not a heading");
  });
});

describe("copied text for other apps", () => {
  it("keeps link labels and drops IDs", () => {
    const id = "0192f3a4-7c1e-7b2a-9f00-000000000002";
    expect(withoutIds(`See [[Weil|${id}]] and ![[A quote|${id}]].`)).toBe("See [[Weil]] and ![[A quote]].");
  });
});

describe("the editor's clipboard", () => {
  it("pastes a web page's HTML as Markdown, and copies links without IDs (but keeps them for the app)", async () => {
    const { createEditor } = await import("../src/editor/editor");
    const { EditorSelection } = await import("@codemirror/state");
    const parent = document.createElement("div");
    document.body.replaceChildren(parent);
    const id = "0192f3a4-7c1e-7b2a-9f00-000000000002";
    const view = createEditor({ parent, doc: `A [[Weil|${id}]] b`, label: "Note", targets: () => [], open: () => {}, titleOf: () => null });
    const event = (type: string, data: Record<string, string>) => {
      const store = { ...data };
      const e = new Event(type, { bubbles: true, cancelable: true }) as ClipboardEvent;
      Object.defineProperty(e, "clipboardData", { value: { getData: (t: string) => store[t] ?? "", setData: (t: string, v: string) => (store[t] = v) } });
      return { e, store };
    };
    // Copy: plain text without the ID, the exact text for the app.
    view.dispatch({ selection: EditorSelection.range(0, view.state.doc.length) });
    const c = event("copy", {});
    view.contentDOM.dispatchEvent(c.e);
    expect(c.store["text/plain"]).toBe("A [[Weil]] b");
    expect(c.store["application/x-librarium-markdown"]).toBe(`A [[Weil|${id}]] b`);
    // Paste HTML from elsewhere.
    view.dispatch({ selection: EditorSelection.cursor(view.state.doc.length) });
    const p = event("paste", { "text/html": "<p>See <strong>this</strong>.</p>", "text/plain": "See this." });
    view.contentDOM.dispatchEvent(p.e);
    expect(view.state.doc.toString()).toBe(`A [[Weil|${id}]] bSee **this**.`);
    // Pasting the app's own copy keeps the IDs.
    const q = event("paste", { "application/x-librarium-markdown": `[[Weil|${id}]]`, "text/plain": "[[Weil]]" });
    view.contentDOM.dispatchEvent(q.e);
    expect(view.state.doc.toString()).toContain(`**this**.[[Weil|${id}]]`);
  });
});
