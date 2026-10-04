/** Lists: Tab and ⇧Tab move an item with what is under it; numbered lists renumber. */
import { describe, expect, it } from "vitest";
import { EditorSelection } from "@codemirror/state";
import { createEditor } from "../src/editor/editor";
import { indentListItem, outdentListItem } from "../src/editor/lists";

function editor(doc: string, at: number) {
  const parent = document.createElement("div");
  document.body.replaceChildren(parent);
  const view = createEditor({ parent, doc, label: "Note", targets: () => [], open: () => {}, titleOf: () => null });
  view.dispatch({ selection: EditorSelection.cursor(at) });
  return view;
}
const text = (v: ReturnType<typeof editor>) => v.state.doc.toString();

describe("lists", () => {
  it("Tab moves an item, with its children, under the item before it", () => {
    const doc = "- a\n- b\n  - c\n- d";
    const v = editor(doc, doc.indexOf("b"));
    indentListItem(v);
    expect(text(v)).toBe("- a\n  - b\n    - c\n- d");
    outdentListItem(v);
    expect(text(v)).toBe(doc);
  });

  it("aligns under a numbered item's text, and renumbers", () => {
    const doc = "1. one\n2. two\n3. three";
    const v = editor(doc, doc.indexOf("two"));
    indentListItem(v);
    expect(text(v)).toBe("1. one\n   1. two\n2. three");
    outdentListItem(v);
    expect(text(v)).toBe("1. one\n2. two\n3. three");
  });

  it("leaves the first item, and lines that aren't list items, to ordinary indenting", () => {
    const doc = "- a\n- b";
    const v = editor(doc, 1);
    expect(indentListItem(v)).toBe(true);
    expect(text(v)).toBe(doc);
    const w = editor("plain text", 0);
    expect(indentListItem(w)).toBe(false);
  });

  it("hangs wrapped lines of an item under its text", () => {
    const v = editor("- a long item\n\nplain", 0);
    const line = v.contentDOM.querySelector<HTMLElement>(".cm-line")!;
    expect(line.style.paddingLeft).toBe("1.2em");
  });
});
