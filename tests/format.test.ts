/** Formatting commands toggle, wrap the selection, and work with several cursors. */
import { describe, expect, it } from "vitest";
import { EditorSelection } from "@codemirror/state";
import { createEditor } from "../src/editor/editor";
import { insertLink, setHeading, toggleInline, toggleTask } from "../src/editor/format";

function editor(doc: string, ranges: [number, number][]) {
  const parent = document.createElement("div");
  document.body.replaceChildren(parent);
  const view = createEditor({ parent, doc, label: "Note", targets: () => [], open: () => {}, titleOf: () => null });
  view.dispatch({ selection: EditorSelection.create(ranges.map(([a, b]) => EditorSelection.range(a, b))) });
  return view;
}
const text = (v: ReturnType<typeof editor>) => v.state.doc.toString();
const sel = (v: ReturnType<typeof editor>) => v.state.sliceDoc(v.state.selection.main.from, v.state.selection.main.to);

describe("formatting", () => {
  it("bolds a selection, and un-bolds it from anywhere inside", () => {
    const v = editor("a word here", [[2, 6]]);
    toggleInline("bold")(v);
    expect(text(v)).toBe("a **word** here");
    expect(sel(v)).toBe("word");
    v.dispatch({ selection: EditorSelection.cursor(5) });
    toggleInline("bold")(v);
    expect(text(v)).toBe("a word here");
  });

  it("italic, strikethrough, highlight and code, on several selections at once", () => {
    const v = editor("one two", [[0, 3], [4, 7]]);
    toggleInline("italic")(v);
    expect(text(v)).toBe("*one* *two*");
    for (const [k, out] of [["strike", "~~x~~"], ["highlight", "==x=="], ["code", "`x`"]] as const) {
      const w = editor("x", [[0, 1]]);
      toggleInline(k)(w);
      expect(text(w)).toBe(out);
    }
  });

  it("with nothing selected, puts the marks around the cursor", () => {
    const v = editor("ab", [[1, 1]]);
    toggleInline("bold")(v);
    expect(text(v)).toBe("a****b");
    expect(v.state.selection.main.head).toBe(3);
  });

  it("⌘K makes a link from words, or from an address", () => {
    const v = editor("see this", [[4, 8]]);
    insertLink(v);
    expect(text(v)).toBe("see [this]()");
    expect(v.state.selection.main.head).toBe(11);
    const w = editor("https://example.org", [[0, 19]]);
    insertLink(w);
    expect(text(w)).toBe("[](https://example.org)");
    expect(w.state.selection.main.head).toBe(1);
  });

  it("⌘L makes a task, ticks it and unticks it", () => {
    const v = editor("buy bread\n- milk", [[0, 13]]);
    toggleTask(v);
    expect(text(v)).toBe("- [ ] buy bread\n- [ ] milk");
    toggleTask(v);
    expect(text(v)).toBe("- [x] buy bread\n- [x] milk");
    toggleTask(v);
    expect(text(v)).toBe("- [ ] buy bread\n- [ ] milk");
  });

  it("sets heading levels, and the same level again goes back to body text", () => {
    const v = editor("Title", [[0, 0]]);
    setHeading(2)(v);
    expect(text(v)).toBe("## Title");
    setHeading(3)(v);
    expect(text(v)).toBe("### Title");
    setHeading(3)(v);
    expect(text(v)).toBe("Title");
  });

  it("wraps a selection when a markup character is typed", () => {
    const v = editor("a word", [[2, 6]]);
    const handled = v.state.facet((v.constructor as typeof import("@codemirror/view").EditorView).inputHandler).some((h) => h(v, 2, 6, "=", () => v.state.update({})));
    expect(handled).toBe(true);
    expect(text(v)).toBe("a =word=");
    expect(sel(v)).toBe("word");
  });

  it("allows several cursors", () => {
    const v = editor("a a a", [[0, 1], [2, 3]]);
    expect(v.state.selection.ranges).toHaveLength(2);
  });
});
