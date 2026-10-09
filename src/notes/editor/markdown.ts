/**
 * Markdown for the editor: CommonMark + GFM (tables, tasks, strikethrough) + `==highlight==`,
 * without indented code blocks (indentation is indentation). Fenced code is highlighted by
 * language, each language loaded the first time a note uses it.
 */
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { LanguageDescription, LanguageSupport, StreamLanguage, syntaxHighlighting } from "@codemirror/language";
import { classHighlighter, tags, Tag } from "@lezer/highlight";
import type { MarkdownConfig } from "@lezer/markdown";
import { NoIndentedCode } from "./links";

const highlightTag = Tag.define();
const HighlightDelim = { resolve: "Highlight", mark: "HighlightMark" };

/** `==text==` as a Highlight node with HighlightMark delimiters. */
const Highlight: MarkdownConfig = {
  defineNodes: [{ name: "Highlight", style: highlightTag }, { name: "HighlightMark", style: tags.processingInstruction }],
  parseInline: [
    {
      name: "Highlight",
      parse(cx, next, pos) {
        if (next !== 61 /* = */ || cx.char(pos + 1) !== 61) return -1;
        const canOpen = /\S/.test(cx.slice(pos + 2, pos + 3));
        const canClose = /\S/.test(cx.slice(pos - 1, pos));
        return cx.addDelimiter(HighlightDelim, pos, pos + 2, canOpen, canClose);
      },
      after: "Emphasis",
    },
  ],
};

/** The languages a fenced block may name (```js, ```python…). */
const codeLanguages: LanguageDescription[] = [
  LanguageDescription.of({ name: "JavaScript", alias: ["js", "javascript", "jsx", "mjs"], load: async () => (await import("@codemirror/lang-javascript")).javascript({ jsx: true }) }),
  LanguageDescription.of({ name: "TypeScript", alias: ["ts", "typescript", "tsx"], load: async () => (await import("@codemirror/lang-javascript")).javascript({ typescript: true, jsx: true }) }),
  LanguageDescription.of({ name: "Python", alias: ["py", "python"], load: async () => (await import("@codemirror/lang-python")).python() }),
  LanguageDescription.of({ name: "Rust", alias: ["rs", "rust"], load: async () => (await import("@codemirror/lang-rust")).rust() }),
  LanguageDescription.of({ name: "JSON", alias: ["json"], load: async () => (await import("@codemirror/lang-json")).json() }),
  LanguageDescription.of({ name: "CSS", alias: ["css"], load: async () => (await import("@codemirror/lang-css")).css() }),
  LanguageDescription.of({ name: "HTML", alias: ["html", "xml", "svg"], load: async () => (await import("@codemirror/lang-html")).html() }),
  LanguageDescription.of({ name: "SQL", alias: ["sql"], load: async () => (await import("@codemirror/lang-sql")).sql() }),
  LanguageDescription.of({ name: "Shell", alias: ["sh", "bash", "zsh", "shell", "console"], load: async () => new LanguageSupport(StreamLanguage.define((await import("@codemirror/legacy-modes/mode/shell")).shell)) }),
];

export function markdownSupport() {
  return [
    markdown({ base: markdownLanguage, extensions: [Highlight, NoIndentedCode], addKeymap: false, codeLanguages }),
    // Code tokens get `tok-*` classes, coloured inside code blocks only (notes.css).
    syntaxHighlighting(classHighlighter),
  ];
}
