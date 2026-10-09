/**
 * Mends and places a PDF's selectable text.
 *
 * Mending: PDFs printed by WebKit (saved web pages) leave ligature glyphs out of a font's
 * ToUnicode map, and PDF.js then reads the glyph's code as a letter ("different" as
 * "diSerent", "fiction" as "Pction"). The PDF's stored text (PDFKit, or the saved page's own)
 * has the right words: a word it doesn't know, which becomes one of its words with one letter
 * read as a ligature, is changed to that word. Find, selection and copying all see the mended
 * text.
 *
 * Placing: PDF.js lays out each run of text (often a whole line) as one element in a generic
 * font, stretched to the run's width. Glyph widths differ from the PDF's own font, so along a
 * line the letters drift from the printed ones, and find matches and selections land a
 * character or two off (very visible in saved web pages, set in web fonts). Here each run is
 * split into words, and each word is placed using the PDF font's own glyph widths, so drift
 * can only build up within a word. Splitting keeps the text (the pieces join back into the run,
 * and only the last keeps the line end).
 */

/** A text item as PDF.js gives it (the parts used here). */
interface TextItem {
  str: string;
  dir?: string;
  width: number;
  height: number;
  transform: number[];
  fontName: string;
  hasEOL: boolean;
}

/** What is needed of a PDF font: each character's advance, in glyph units (1000 to the em). */
type Advance = (ch: string) => number | null;

/** Splits runs into words placed by their font's advances; items it can't place stay whole. */
function splitIntoWords<T>(items: (T | TextItem)[], advanceFor: (fontName: string) => Advance | null): (T | TextItem)[] {
  const out: (T | TextItem)[] = [];
  for (const it of items) {
    if (!isText(it)) {
      out.push(it);
      continue;
    }
    out.push(...splitItem(it, advanceFor(it.fontName)));
  }
  return out;
}

function isText(it: unknown): it is TextItem {
  return typeof (it as TextItem)?.str === "string" && Array.isArray((it as TextItem).transform);
}

function splitItem(it: TextItem, advance: Advance | null): TextItem[] {
  const [a, b, c, d, e, f] = it.transform as [number, number, number, number, number, number];
  // Only plain left-to-right horizontal runs of more than one word.
  if (!advance || !(a > 0) || b !== 0 || c !== 0 || (it.dir && it.dir !== "ltr") || !(it.width > 0) || !/\S\s+\S/.test(it.str)) return [it];
  const chars = [...it.str];
  const cum: number[] = [0];
  for (const ch of chars) {
    const w = advance(ch);
    if (w === null || !Number.isFinite(w) || w < 0) return [it];
    cum.push(cum[cum.length - 1]! + w);
  }
  const total = cum[cum.length - 1]!;
  if (!(total > 0)) return [it];
  // Words with the spaces after them; the run's measured width is shared out by advance.
  const pieces: TextItem[] = [];
  const re = /\S+\s*|\s+/gu;
  let m: RegExpExecArray | null;
  let at = 0;
  while ((m = re.exec(it.str))) {
    const n = [...m[0]].length;
    const x0 = (cum[at]! / total) * it.width;
    const x1 = (cum[at + n]! / total) * it.width;
    pieces.push({ ...it, str: m[0], width: x1 - x0, transform: [a, b, c, d, e + x0, f], hasEOL: false });
    at += n;
  }
  pieces[pieces.length - 1]!.hasEOL = it.hasEOL;
  return pieces;
}

/** What a misread ligature can stand for. */
const LIGATURES = ["ff", "fi", "fl", "ffi", "ffl", "ft"];

/** A word as looked up: lower case, without the punctuation around it. */
const bare = (w: string) => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "").toLowerCase();

/** The words of a stored text, to mend against. */
export function knownWords(text: string | null): Set<string> {
  return new Set((text ?? "").split(/\s+/).map(bare).filter(Boolean));
}

const upper = (c: string | undefined) => !!c && /\p{Lu}/u.test(c);
const wordy = (c: string) => /[\p{L}\p{N}]/u.test(c);

/**
 * A word with its misread ligatures restored, if that makes it a known word. A misread
 * ligature is never inside a run of capitals ("SEP"), never the word's only letter, and if it
 * is a letter of the ligature, it is the first ("ofce" for "office", not "Let" for "Left").
 */
function mendWord(w: string, known: Set<string>): string {
  if (![...w].some(wordy) || known.has(bare(w))) return w;
  const chars = [...w];
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i]!;
    if (upper(chars[i + 1]) || (upper(chars[i - 1]) && upper(chars[i - 2]))) continue;
    if (!chars.some((d) => d !== c && wordy(d))) continue;
    for (const lig of LIGATURES) {
      if (lig.includes(c) && c !== lig[0]) continue;
      // The one letter, or every one like it (the same ligature twice in a word).
      const one = [...chars.slice(0, i), lig, ...chars.slice(i + 1)].join("");
      if (known.has(bare(one))) return one;
      const all = chars.map((d) => (d === c ? lig : d)).join("");
      if (known.has(bare(all))) return all;
    }
  }
  return w;
}

/** Items' text with misread ligatures restored. */
function mendItems<T>(items: (T | TextItem)[], known: Set<string>): (T | TextItem)[] {
  if (!known.size) return items;
  return items.map((it) => {
    if (!isText(it)) return it;
    const str = it.str.replace(/\S+/gu, (w) => mendWord(w, known));
    return str === it.str ? it : { ...it, str };
  });
}

/** A PDF.js font's data (with `fontExtraProperties`), as far as advances go. */
interface FontData {
  widths?: Record<number, number> | number[];
  defaultWidth?: number;
  toUnicode?: { _map?: (string | undefined)[]; firstChar?: number; lastChar?: number };
  vertical?: boolean;
  isType3Font?: boolean;
}

/** Advances from a font's widths, found through its character-to-text map. */
function advancesOf(font: FontData | null | undefined): Advance | null {
  if (!font || font.vertical || font.isType3Font || !font.widths) return null;
  const widths = font.widths as Record<number, number>;
  const map = font.toUnicode?._map;
  const codes = new Map<string, number>();
  if (Array.isArray(map)) {
    map.forEach((u, code) => {
      if (typeof u === "string" && u.length && !codes.has(u)) codes.set(u, code);
    });
  } else if (font.toUnicode && typeof font.toUnicode.firstChar === "number") {
    // An identity map: codes are the characters.
  } else return null;
  const identity = !Array.isArray(map);
  const fallback = typeof font.defaultWidth === "number" && font.defaultWidth > 0 ? font.defaultWidth : null;
  return (ch) => {
    const code = identity ? ch.codePointAt(0)! : codes.get(ch);
    if (code === undefined) return fallback;
    const w = widths[code];
    return typeof w === "number" && w > 0 ? w : fallback;
  };
}

/* eslint-disable @typescript-eslint/no-explicit-any -- PDF.js's page proxies are untyped here */
const wrapped = new WeakSet<object>();
/**
 * Makes a page's text content come mended and in words placed by their font's widths. Every
 * reader of the page's text (the text layer, find) goes through it, so all see the same text.
 * Fonts are looked up as the text is read: the text layer is read after the page starts
 * drawing, when they are loaded; text read before (find, on pages not yet drawn) stays whole.
 */
export function placeWords(page: any, known: Promise<Set<string>>): void {
  if (!page || wrapped.has(page) || typeof page.streamTextContent !== "function") return;
  wrapped.add(page);
  const stream = page.streamTextContent.bind(page);
  page.streamTextContent = (params: unknown) => {
    const reader = stream(params).getReader();
    const fonts = new Map<string, Advance | null>();
    const advanceFor = (name: string) => {
      if (!fonts.has(name)) {
        let font: FontData | null;
        try {
          font = page.commonObjs?.has(name) ? page.commonObjs.get(name) : null;
        } catch {
          font = null;
        }
        fonts.set(name, advancesOf(font));
      }
      return fonts.get(name)!;
    };
    return new ReadableStream({
      async pull(ctl) {
        const { value, done } = await reader.read();
        if (done) return ctl.close();
        ctl.enqueue({ ...value, items: splitIntoWords(mendItems(value.items, await known), advanceFor) });
      },
      cancel: (why) => reader.cancel(why),
    });
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */
