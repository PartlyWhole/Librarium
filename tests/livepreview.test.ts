/** Live preview: marks hidden except on the construct being edited; text that isn't markup stays. */
import { describe, expect, it } from "vitest";
import { EditorSelection } from "@codemirror/state";
import { cursorCharRight } from "@codemirror/commands";
import { createEditor } from "../src/editor/editor";

const ID = "0192f3a4-7c1e-7b2a-9f00-000000000002";

function editor(doc: string, cursor?: number) {
  const parent = document.createElement("div");
  document.body.replaceChildren(parent);
  const view = createEditor({ parent, doc, label: "Note", targets: () => [], open: () => {}, titleOf: () => "Waiting for God" });
  if (cursor !== undefined) view.dispatch({ selection: EditorSelection.cursor(cursor) });
  else view.dispatch({ selection: EditorSelection.cursor(doc.length) });
  return view;
}

/** What the reader sees: the editor's text with hidden ranges gone and widgets as text. */
const seen = (view: ReturnType<typeof editor>) => view.contentDOM.textContent ?? "";

describe("live preview", () => {
  it("reveals only the construct the cursor is in, faintly", () => {
    const doc = "One **bold** and *it* here.\n\nNext.";
    const away = editor(doc);
    expect(seen(away)).toContain("One bold and it here.");
    // The cursor in "bold": its stars show (dimmed); the italic's don't.
    const v = editor(doc, 7);
    expect(seen(v)).toContain("One **bold** and it here.");
    expect(v.contentDOM.querySelectorAll(".cm-mark-dim").length).toBe(2);
  });

  it("shows a link being edited as [[label]], its ID hidden and skipped as one unit", () => {
    const doc = `See [[Weil|${ID}]] now.`;
    expect(seen(editor(doc))).toBe("See Weil now.");
    const v = editor(doc, 8);
    expect(seen(v)).toBe("See [[Weil]] now.");
    // Moving right from just before the ID's place lands after it, in one step.
    const before = doc.indexOf(`|${ID}`);
    v.dispatch({ selection: EditorSelection.cursor(before) });
    cursorCharRight(v);
    expect(v.state.selection.main.head).toBe(before + ID.length + 1);
    expect(seen(v)).not.toContain(ID);
  });

  it("never hides bare addresses, [brackets] that aren't links, or reference definitions", () => {
    const doc = "Read https://example.org/a and <https://b.org> [sic] [^1] [!note]\n\n[ref]: https://r.org\n\nend";
    const v = editor(doc, doc.length);
    const t = seen(v);
    expect(t).toContain("https://example.org/a");
    expect(t).toContain("https://b.org");
    expect(t).not.toContain("<https://b.org>");
    expect(t).toContain("[sic] [^1] [!note]");
    expect(t).toContain("[ref]: https://r.org");
    expect(v.contentDOM.querySelectorAll(".cm-url[data-url]").length).toBe(2);
  });

  it("shows a Markdown link's words, styled and carrying its address; an image its alt", () => {
    const doc = "A [fine essay](https://example.org/e) and ![a chart](img.png).\n\nend";
    const v = editor(doc);
    expect(seen(v)).toContain("A fine essay and a chart.");
    const a = v.contentDOM.querySelector<HTMLElement>(".cm-md-link")!;
    expect(a.dataset.url).toBe("https://example.org/e");
    expect(v.contentDOM.querySelector(".cm-image-alt")?.textContent).toBe("a chart");
    // Being edited: all of it, the marks dimmed.
    expect(seen(editor(doc, 5))).toContain("[fine essay](https://example.org/e)");
  });

  it("shows bullets as dots and tasks as checkboxes, except on the line being edited", () => {
    const doc = "- one\n- [ ] two\n- three";
    const v = editor(doc, doc.length);
    expect(v.contentDOM.querySelectorAll(".cm-bullet").length).toBe(1);
    expect(v.contentDOM.querySelectorAll("input.cm-task").length).toBe(1);
    expect(seen(v)).toContain("- three");
  });

  it("opens a web link on a click (asking first), unless it is being edited", () => {
    const doc = "A [fine essay](https://example.org/e).\n\nend";
    const v = editor(doc);
    let asked: string | null = null;
    const on = (e: Event) => (asked = (e as CustomEvent<{ url: string }>).detail.url);
    document.addEventListener("open-link", on);
    v.contentDOM.querySelector(".cm-md-link")!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
    document.removeEventListener("open-link", on);
    expect(asked).toBe("https://example.org/e");
  });
});
