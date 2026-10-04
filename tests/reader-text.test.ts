import { describe, expect, it } from "vitest";
import { advancesOf, splitIntoWords, type TextItem } from "../src/reader/pdf-words";
import { boxesIn, snapToWords } from "../src/reader/host";

const item = (str: string, extra: Partial<TextItem> = {}): TextItem => ({ str, width: 100, height: 10, transform: [10, 0, 0, 10, 50, 700], fontName: "f1", hasEOL: true, ...extra });

describe("PDF text placed where the printed words are", () => {
  // "i" is narrow, "m" wide: a generic font would put the words elsewhere.
  const adv = (ch: string) => ({ i: 250, m: 750, " ": 250 })[ch] ?? null;

  it("splits a run into words placed by the font's advances", () => {
    const out = splitIntoWords([item("iii mmm")], () => adv) as TextItem[];
    expect(out.map((i) => i.str)).toEqual(["iii ", "mmm"]);
    // Advances 250×3 + 250 = 1000 of 3250 in all: the second word starts at 1000/3250 of the run.
    expect(out[1]!.transform[4]).toBeCloseTo(50 + (1000 / 3250) * 100, 6);
    expect(out[0]!.width + out[1]!.width).toBeCloseTo(100, 6);
  });

  it("keeps the text (the pieces join back into the run) and the line end on the last piece", () => {
    const out = splitIntoWords([item("Attention is the rarest")], () => () => 500) as TextItem[];
    expect(out.map((i) => i.str).join("")).toBe("Attention is the rarest");
    expect(out.map((i) => i.hasEOL)).toEqual([false, false, false, true]);
  });

  it("leaves alone what it can't place: unknown fonts or characters, rotated runs, single words, marked content", () => {
    const marked = { type: "beginMarkedContent" };
    expect(splitIntoWords([item("a b")], () => null)).toHaveLength(1);
    expect(splitIntoWords([item("a b")], () => (ch) => (ch === "b" ? null : 500))).toHaveLength(1);
    expect(splitIntoWords([item("a b", { transform: [0, 10, -10, 0, 50, 700] })], () => () => 500)).toHaveLength(1);
    expect(splitIntoWords([item("word")], () => () => 500)).toHaveLength(1);
    expect(splitIntoWords([marked, item("a b")], () => () => 500)).toEqual([marked, expect.objectContaining({ str: "a " }), expect.objectContaining({ str: "b" })]);
  });

  it("reads advances through the font's character map, or an identity map", () => {
    const mapped = advancesOf({ widths: { 3: 600, 4: 300 }, toUnicode: { _map: [undefined, undefined, undefined, "a", "b"] }, defaultWidth: 500 })!;
    expect([mapped("a"), mapped("b"), mapped("z")]).toEqual([600, 300, 500]);
    const identity = advancesOf({ widths: { 97: 610 }, toUnicode: { firstChar: 0, lastChar: 255 } })!;
    expect(identity("a")).toBe(610);
    expect(advancesOf({ widths: {}, toUnicode: { _map: [] }, vertical: true })).toBeNull();
    expect(advancesOf(null)).toBeNull();
  });
});

describe("a selection's boxes, one per line", () => {
  // A very tall page (a saved web page): lines 30 px apart are 0.3% of its height apart.
  const page = document.createElement("div");
  page.getBoundingClientRect = () => new DOMRect(0, 0, 1000, 10000);
  const rangeOf = (rects: DOMRect[]) => ({ getClientRects: () => rects }) as unknown as Range;

  it("keeps every line of a long selection on a tall page", () => {
    const lines = Array.from({ length: 10 }, (_, i) => new DOMRect(100, 2000 + i * 30, 700, 19));
    const boxes = boxesIn(rangeOf(lines), page, 1);
    expect(boxes).toHaveLength(10);
    expect(boxes.map((b) => b.y)).toEqual(lines.map((r) => r.top / 100));
  });

  it("joins the pieces of one line into one box", () => {
    const boxes = boxesIn(rangeOf([new DOMRect(100, 2000, 50, 19), new DOMRect(150, 2001, 80, 18), new DOMRect(100, 2030, 60, 19)]), page);
    expect(boxes).toHaveLength(2);
    expect(boxes[0]).toMatchObject({ x: 10, w: 13, y: 20, h: 0.19 });
  });
});

describe("a mouse selection takes whole words", () => {
  const p = document.createElement("p");
  p.textContent = "Attention is the rarest form of generosity.";
  document.body.appendChild(p);
  const text = p.firstChild!;
  const sel = window.getSelection()!;

  it("widens a drag that starts and ends inside words", () => {
    sel.setBaseAndExtent(text, 3, text, 19); // "ention is the ra"
    snapToWords(sel);
    expect(sel.toString()).toBe("Attention is the rarest");
  });

  it("keeps a backward drag backward", () => {
    sel.setBaseAndExtent(text, 19, text, 3);
    snapToWords(sel);
    expect(sel.toString()).toBe("Attention is the rarest");
    expect(sel.anchorOffset).toBe(23);
    expect(sel.focusOffset).toBe(0);
  });

  it("leaves a selection that already ends at word edges", () => {
    sel.setBaseAndExtent(text, 13, text, 16); // "the"
    snapToWords(sel);
    expect(sel.toString()).toBe("the");
  });
});
