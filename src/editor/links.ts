/**
 * The editor's link parser (§5.4), tested against the same fixture file as the kernel's.
 * Code spans and blocks come from the Lezer Markdown parser, not a regex.
 */
import { parser as baseParser, GFM, type MarkdownConfig } from "@lezer/markdown";
import type { Tree } from "@lezer/common";

export interface Link {
  from: number;
  to: number;
  label: string;
  id: string | null;
  embed: boolean;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Indentation is indentation, not code (decision 0058): only fenced blocks and spans are. */
export const NoIndentedCode: MarkdownConfig = { remove: ["IndentedCode"] };
const mdParser = baseParser.configure([GFM, NoIndentedCode]);
const CODE = new Set(["InlineCode", "FencedCode", "CodeBlock", "HTMLBlock", "HTMLTag", "CommentBlock", "Comment"]);

export function escapeLabel(label: string): string {
  return label.replace(/[\\[\]|]/g, (c) => `\\${c}`).replace(/[\r\n]+/g, " ");
}

export function formatLink(label: string, id: string, embed = false): string {
  return `${embed ? "!" : ""}[[${escapeLabel(label)}|${id}]]`;
}

function unescape(s: string): string {
  return s.replace(/\\([\\[\]|])/g, "$1");
}

function splitInner(inner: string): { label: string; id: string | null } {
  let lastBar = -1;
  let lastEscBar = -1;
  for (let i = 0; i < inner.length; i++) {
    if (inner[i] === "\\" && i + 1 < inner.length) {
      if (inner[i + 1] === "|") lastEscBar = i;
      i++;
      continue;
    }
    if (inner[i] === "|") lastBar = i;
  }
  if (lastBar >= 0) {
    const id = inner.slice(lastBar + 1);
    if (UUID.test(id)) return { label: unescape(inner.slice(0, lastBar)), id };
  } else if (lastEscBar >= 0) {
    const id = inner.slice(lastEscBar + 2);
    if (UUID.test(id)) return { label: unescape(inner.slice(0, lastEscBar)), id };
  }
  return { label: unescape(inner), id: null };
}

/** Code ranges, from a syntax tree (the editor's) or a fresh parse. */
export function codeRanges(text: string, tree?: Tree, from = 0, to = text.length): [number, number][] {
  const out: [number, number][] = [];
  (tree ?? mdParser.parse(text)).iterate({
    from,
    to,
    enter(n) {
      if (CODE.has(n.name)) {
        out.push([n.from, n.to]);
        return false;
      }
      return undefined;
    },
  });
  return out;
}

/** Every link and embed in `text` (offsets are UTF-16, as in the editor). */
export function parseLinks(text: string, tree?: Tree, from = 0, to = text.length): Link[] {
  const code = codeRanges(text, tree, from, to);
  const inCode = (p: number) => code.some(([a, b]) => p >= a && p < b);
  const out: Link[] = [];
  let i = from;
  while (i + 1 < to) {
    const c = text[i];
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === "[" && text[i + 1] === "[" && !inCode(i)) {
      let j = i + 2;
      let end = -1;
      while (j < text.length) {
        const d = text[j];
        if (d === "\\") j += 2;
        else if (d === "\n" || d === "\r" || d === "[") break;
        else if (d === "]") {
          if (text[j + 1] === "]") end = j;
          break;
        } else j++;
      }
      if (end >= 0) {
        const inner = text.slice(i + 2, end);
        const embed = i > 0 && text[i - 1] === "!" && !(i > 1 && text[i - 2] === "\\");
        if (inner.length) out.push({ from: embed ? i - 1 : i, to: end + 2, embed, ...splitInner(inner) });
        i = end + 2;
        continue;
      }
    }
    i++;
  }
  return out;
}
