/**
 * The clipboard, as a writer expects:
 * - Pasting from a web page or a document gives Markdown (headings, emphasis, links, lists…),
 *   not flattened text; ⇧⌥⌘V pastes plain text.
 * - Copying from a note gives `[[label]]` to other apps (no IDs), and the exact text, IDs and
 *   all, when pasted back into Librarium.
 */
import { EditorView, type Command } from "@codemirror/view";
import { htmlToMarkdown } from "./html2md";
import { parseLinks } from "./links";

/** Librarium's own copy of copied text (with links' IDs), for pasting back into the app. */
const OWN = "application/x-librarium-markdown";

/** HTML worth converting: it carries structure or formatting, and isn't a code editor's. */
function worthConverting(html: string): boolean {
  if (/white-space:\s*pre/i.test(html) || /<meta[^>]+vscode/i.test(html)) return false;
  return /<(h[1-6]|strong|b|em|i|a\s[^>]*href|ul|ol|li|blockquote|table|pre|code|img|mark|del|s)\b/i.test(html);
}

/** `[[label|id]]` → `[[label]]` (and `![[…]]` likewise), for other apps. */
function withoutIds(text: string): string {
  let out = "";
  let last = 0;
  for (const l of parseLinks(text)) {
    out += text.slice(last, l.from) + `${l.embed ? "!" : ""}[[${l.label}]]`;
    last = l.to;
  }
  return out + text.slice(last);
}

function insert(view: EditorView, text: string): void {
  view.dispatch(view.state.update(view.state.replaceSelection(text), { userEvent: "input.paste", scrollIntoView: true }));
}

export const clipboard = EditorView.domEventHandlers({
  paste(e, view) {
    const data = e.clipboardData;
    if (!data || view.state.readOnly) return false;
    // Files (a copied image) are stored as library items, not pasted as text (editor.ts).
    if (data.files?.length) return false;
    const own = data.getData(OWN);
    if (own) {
      e.preventDefault();
      insert(view, own);
      return true;
    }
    const html = data.getData("text/html");
    if (html && worthConverting(html)) {
      const md = htmlToMarkdown(html);
      if (md) {
        e.preventDefault();
        insert(view, md);
        return true;
      }
    }
    return false;
  },
  copy(e, view) {
    return copyOut(e, view, false);
  },
  cut(e, view) {
    return copyOut(e, view, true);
  },
});

function copyOut(e: ClipboardEvent, view: EditorView, cut: boolean): boolean {
  const { state } = view;
  const ranges = state.selection.ranges.filter((r) => !r.empty);
  if (!ranges.length || !e.clipboardData) return false;
  const text = ranges.map((r) => state.sliceDoc(r.from, r.to)).join(state.lineBreak);
  const plain = withoutIds(text);
  if (plain === text) return false;
  e.preventDefault();
  e.clipboardData.setData("text/plain", plain);
  e.clipboardData.setData(OWN, text);
  if (cut && !state.readOnly) view.dispatch({ changes: ranges.map((r) => ({ from: r.from, to: r.to })), userEvent: "delete.cut" });
  return true;
}

/** ⇧⌥⌘V: pastes the clipboard's plain text, as it is. */
const pastePlain: Command = (view) => {
  if (view.state.readOnly) return false;
  void navigator.clipboard?.readText().then((t) => t && insert(view, t), () => {});
  return true;
};

export const clipboardKeymap = [{ key: "Mod-Alt-Shift-v", run: pastePlain }];
