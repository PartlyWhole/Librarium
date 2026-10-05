/**
 * Markdown for the editor: CommonMark + GFM (tables, tasks, strikethrough) + `==highlight==`,
 * without indented code blocks (indentation is indentation; decision 0058).
 */
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { tags, Tag } from "@lezer/highlight";
import type { MarkdownConfig } from "@lezer/markdown";
import { codeLanguages } from "./code";
import { NoIndentedCode } from "./links";

export const highlightTag = Tag.define();

/** `==text==` as a Highlight node with HighlightMark delimiters. */
export const Highlight: MarkdownConfig = {
  defineNodes: [{ name: "Highlight", style: highlightTag }, { name: "HighlightMark", style: tags.processingInstruction }],
  parseInline: [
    {
      name: "Highlight",
      parse(cx, next, pos) {
        if (next !== 61 /* = */ || cx.char(pos + 1) !== 61) return -1;
        const before = cx.slice(pos - 1, pos);
        const after = cx.slice(pos + 2, pos + 3);
        const canOpen = /\S/.test(after);
        const canClose = /\S/.test(before);
        return cx.addDelimiter(HighlightDelim, pos, pos + 2, canOpen, canClose);
      },
      after: "Emphasis",
    },
  ],
};

const HighlightDelim = { resolve: "Highlight", mark: "HighlightMark" };

export function markdownSupport() {
  return markdown({ base: markdownLanguage, extensions: [Highlight, NoIndentedCode], addKeymap: true, codeLanguages });
}
