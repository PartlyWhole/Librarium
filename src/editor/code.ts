/**
 * Code blocks highlighted by language (loaded only when a note has such a block). (Folding is
 * in folding.ts.)
 */
import { LanguageDescription, LanguageSupport, StreamLanguage } from "@codemirror/language";
import { classHighlighter } from "@lezer/highlight";
import { syntaxHighlighting } from "@codemirror/language";

/** The languages a fenced block may name (```js, ```python…), each loaded on first use. */
export const codeLanguages: LanguageDescription[] = [
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

/** Code tokens get `tok-*` classes (styled in shell.css, inside code blocks only). */
export const codeHighlighting = syntaxHighlighting(classHighlighter);
