/**
 * Where a capture is used, and what deleting it does to those places (decision 0059).
 *
 * A reference is one `![[…|id]]` (placed quotation) or `[[…|id]]` (link) in a note, a daily
 * note or another capture's words. Before a used capture is deleted, the user chooses for each
 * reference: keep it as text, remove it, or leave it (it then shows as its source until the
 * capture is restored). The rewriting is plain text work, kept here so it can be tested alone.
 */
import { call } from "../../backend";
import { parseLinks, type Link } from "../../editor/links";
import type { Backlink } from "../../generated/Backlink";
import type { RecordInfo } from "../../generated/RecordInfo";
import type { RecordText } from "../../generated/RecordText";

export type Choice = "text" | "remove" | "leave";

export interface Reference {
  source: RecordInfo;
  /** The source's text when it was read, and the version it had. */
  body: string;
  /** Which of this capture's references in the source it is (0-based, in text order). */
  n: number;
  link: Link;
  /** The non-empty line before it, for context (links shown as their labels). */
  before: string;
  /** Its own line, with links shown as their labels. */
  line: string;
  /** Alone on its line (after indentation, quote marks or a list marker). */
  alone: boolean;
}

/** What a capture turns into when it is kept as text. */
export interface AsText {
  /** The quotation (empty for a picture). */
  quote: string;
  /** "Author, Title, p. 3". */
  cite: string;
}

/** A line's text with links and embeds shown as their labels. */
export function readable(line: string): string {
  let out = "";
  let last = 0;
  for (const l of parseLinks(line)) {
    out += line.slice(last, l.from) + l.label;
    last = l.to;
  }
  return (out + line.slice(last)).trim();
}

function lineAt(body: string, pos: number): { from: number; to: number } {
  const from = body.lastIndexOf("\n", pos - 1) + 1;
  const end = body.indexOf("\n", pos);
  return { from, to: end < 0 ? body.length : end };
}

/** Every reference to `id` in one text, in order. */
export function referencesIn(source: RecordInfo, body: string, id: string): Reference[] {
  return parseLinks(body)
    .filter((l) => l.id === id)
    .map((link, n) => {
      const ln = lineAt(body, link.from);
      const above = body.slice(0, ln.from).split("\n").map((s) => s.trim()).filter(Boolean).at(-1) ?? "";
      return { source, body, n, link, before: readable(above), line: readable(body.slice(ln.from, ln.to)), alone: standsAlone(body, link) };
    });
}

/** Every reference to a capture, read fresh from the records that link to it. */
export async function findReferences(id: string, records: { get(id: string): RecordInfo | undefined }): Promise<Reference[]> {
  const back = await call<Backlink[]>("links.backlinks", { id }).catch(() => [] as Backlink[]);
  const out: Reference[] = [];
  for (const source of [...new Set(back.map((b) => b.source))]) {
    if (source === id) continue;
    const t = await call<RecordText>("records.read", { id: source }).catch(() => null);
    if (!t) continue;
    out.push(...referencesIn(records.get(source) ?? t.info, t.body, id));
  }
  return out;
}

/** Only indentation, quote marks and a list marker before it on its line. */
const PREFIX = /^([ \t>]*)((?:[-*+]|\d+[.)])[ \t]+)?([ \t>]*)$/;

/** Whether a reference stands alone on its line (after indentation, quote marks or a list marker). */
export function standsAlone(body: string, link: Link): boolean {
  const ln = lineAt(body, link.from);
  return PREFIX.test(body.slice(ln.from, link.from)) && body.slice(link.to, ln.to).trim() === "";
}

/**
 * The text with one reference changed as chosen. A quotation kept as text on its own line
 * becomes a Markdown quotation with its citation (inside a quote, its lines join that quote);
 * in the middle of a sentence it becomes “quote” (cite). A link kept as text becomes its
 * words. Removing takes the line with it when nothing else is on it.
 */
export function rewrite(body: string, link: Link, choice: Choice, asText: AsText): string {
  if (choice === "leave") return body;
  const ln = lineAt(body, link.from);
  const prefix = body.slice(ln.from, link.from);
  const suffix = body.slice(link.to, ln.to);
  const m = PREFIX.exec(prefix);
  const alone = !!m && suffix.trim() === "";
  if (choice === "remove") {
    if (alone) {
      // The whole line, and one line break with it; and one blank line, if it stood between two.
      if (ln.to >= body.length) return body.slice(0, Math.max(0, ln.from - 1)) + body.slice(ln.to);
      const out = body.slice(0, ln.from) + body.slice(ln.to + 1);
      const blankBefore = ln.from === 0 || (out[ln.from - 1] === "\n" && (ln.from < 2 || out[ln.from - 2] === "\n"));
      return blankBefore && out[ln.from] === "\n" ? out.slice(0, ln.from) + out.slice(ln.from + 1) : out;
    }
    // In a sentence: the reference goes, and one of the spaces around it.
    let before = body.slice(0, link.from);
    const after = body.slice(link.to);
    if (/[ \t]$/.test(before) && (after === "" || /^[\s.,;:!?)]/.test(after))) before = before.replace(/[ \t]+$/, "");
    return before + after;
  }
  // Keep as text.
  if (!link.embed) return body.slice(0, link.from) + link.label + body.slice(link.to);
  const quote = asText.quote || "[A captured picture]";
  if (!alone) return body.slice(0, link.from) + `“${quote.replace(/\s*\n\s*/g, " ")}” (${asText.cite})` + body.slice(link.to);
  // Later lines carry the line's indentation and quote marks; a list marker becomes spaces.
  const cont = m![1]! + " ".repeat(m![2]?.length ?? 0) + m![3]!;
  const inQuote = prefix.includes(">");
  const lines = inQuote ? [...quote.split("\n"), "", `— ${asText.cite}`] : [...quote.split("\n").map((l) => `> ${l}`), ">", `> — ${asText.cite}`];
  const text = lines.map((l, i) => (i === 0 ? l : `${cont}${l}`.trimEnd())).join("\n");
  return body.slice(0, link.from) + text + body.slice(link.to);
}

/** The text with each of a source's references changed as chosen (last first, so places hold). */
export function rewriteAll(body: string, refs: { link: Link; choice: Choice }[], asText: AsText): string {
  return [...refs].sort((a, b) => b.link.from - a.link.from).reduce((text, r) => rewrite(text, r.link, r.choice, asText), body);
}
