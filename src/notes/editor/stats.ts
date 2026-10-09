/**
 * Counts for the status bar: words and characters as a reader would count them (link IDs,
 * addresses and Markdown's marks aside), and the outline of a note (its headings).
 */
import { syntaxTree } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";
import { parseLinks } from "./links";

/** The words a reader sees in some Markdown. */
export function readable(md: string): string {
  let out = "";
  let last = 0;
  for (const l of parseLinks(md)) {
    // A link reads as its label; an embed (an image, a quotation) isn't the writer's words.
    out += md.slice(last, l.from) + (l.embed ? " " : ` ${l.label} `);
    last = l.to;
  }
  out += md.slice(last);
  return out
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+[.)])\s+(\[[ xX]\]\s+)?/gm, "")
    .replace(/[*_=~`]+/g, "");
}

const segmenter = typeof Intl !== "undefined" && "Segmenter" in Intl ? new Intl.Segmenter(undefined, { granularity: "word" }) : null;

/** Words and characters (without spaces) in Markdown. */
function countText(md: string): { words: number; chars: number } {
  const t = readable(md);
  let words = 0;
  if (segmenter) for (const s of segmenter.segment(t)) words += s.isWordLike ? 1 : 0;
  else words = (t.match(/\S+/g) ?? []).length;
  return { words, chars: t.replace(/\s/g, "").length };
}

/** What the status bar says about a note (and its selection, when there is one). */
export function countLabel(state: EditorState): string {
  const all = countText(state.doc.toString());
  const sel = state.selection.ranges.filter((r) => !r.empty);
  const fmt = (n: number, one: string) => `${n.toLocaleString()} ${n === 1 ? one : `${one}s`}`;
  if (sel.length) {
    const s = countText(sel.map((r) => state.sliceDoc(r.from, r.to)).join("\n"));
    return `${fmt(s.words, "word")} of ${all.words.toLocaleString()} selected`;
  }
  return `${fmt(all.words, "word")} · ${fmt(all.chars, "character")}`;
}

export interface Heading {
  level: number;
  text: string;
  from: number;
}

/** The note's headings, in order. */
export function outline(state: EditorState): Heading[] {
  const out: Heading[] = [];
  syntaxTree(state).iterate({
    enter(n) {
      const m = /^(?:ATX|Setext)Heading(\d)$/.exec(n.name);
      if (!m) return undefined;
      const line = state.doc.lineAt(n.from).text;
      const text = readable(line).replace(/\s+/g, " ").trim();
      if (text) out.push({ level: Number(m[1]), text, from: n.from });
      return false;
    },
  });
  return out;
}
