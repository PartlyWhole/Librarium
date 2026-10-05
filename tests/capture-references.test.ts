/** What deleting a used capture does to each place it is used (decision 0059). */
import { describe, expect, it } from "vitest";
import { referencesIn, rewrite, rewriteAll, type Choice } from "../src/features/captures/references";
import type { RecordInfo } from "../src/generated/RecordInfo";

const ID = "0192f3a4-7c1e-7b2a-9f00-000000000013";
const E = `![[Technique integrates|${ID}]]`;
const L = `[[my favourite line|${ID}]]`;
const asText = { quote: "Technique integrates everything.", cite: "Ellul, The Technological Society, p. 1" };
const src = { id: "n", title: "Note" } as RecordInfo;

const one = (body: string, choice: Choice) => rewrite(body, referencesIn(src, body, ID)[0]!.link, choice, asText);

describe("finding references", () => {
  it("lists each one in order, with the line before and its own line as labels", () => {
    const body = `# Essay\n\nWhy this matters, see [[Weil|0192f3a4-7c1e-7b2a-9f00-000000000002]].\n\n${E}\n\nAnd ${L} again.`;
    const refs = referencesIn(src, body, ID);
    expect(refs.map((r) => [r.n, r.link.embed, r.before, r.line, r.alone])).toEqual([
      [0, true, "Why this matters, see Weil.", "Technique integrates", true],
      [1, false, "Technique integrates", "And my favourite line again.", false],
    ]);
    expect(referencesIn(src, `\t\t> ${E}`, ID)[0]!.alone).toBe(true);
  });
});

describe("keeping as text", () => {
  it("writes a quotation on its own line as a Markdown quotation with its citation", () => {
    expect(one(`Before.\n\n${E}\n\nAfter.`, "text")).toBe("Before.\n\n> Technique integrates everything.\n>\n> — Ellul, The Technological Society, p. 1\n\nAfter.");
  });

  it("keeps an indented quotation's indentation and quote mark on every line", () => {
    expect(one(`\t\t> ${E}`, "text")).toBe("\t\t> Technique integrates everything.\n\t\t>\n\t\t> — Ellul, The Technological Society, p. 1");
  });

  it("in a list item, later lines line up under the item's text", () => {
    expect(one(`- ${E}`, "text")).toBe("- > Technique integrates everything.\n  >\n  > — Ellul, The Technological Society, p. 1");
  });

  it("in a sentence, quotes it inline with the citation", () => {
    expect(one(`As he says ${E} and so on.`, "text")).toBe("As he says “Technique integrates everything.” (Ellul, The Technological Society, p. 1) and so on.");
  });

  it("a link keeps its words", () => {
    expect(one(`And ${L} again.`, "text")).toBe("And my favourite line again.");
  });

  it("a picture is named, not lost silently", () => {
    expect(rewrite(`${E}`, referencesIn(src, E, ID)[0]!.link, "text", { quote: "", cite: "Ellul" })).toBe("> [A captured picture]\n>\n> — Ellul");
  });
});

describe("removing", () => {
  it("takes a line holding only the reference with it", () => {
    expect(one(`Before.\n${E}\nAfter.`, "remove")).toBe("Before.\nAfter.");
    expect(one(`Before.\n\t- ${E}`, "remove")).toBe("Before.");
    // Between blank lines, one blank line stays.
    expect(one(`Before.\n\n${E}\n\nAfter.`, "remove")).toBe("Before.\n\nAfter.");
  });

  it("in a sentence, takes one space with it", () => {
    expect(one(`And ${L} again.`, "remove")).toBe("And again.");
    expect(one(`The end ${L}.`, "remove")).toBe("The end.");
  });
});

describe("leaving and several at once", () => {
  it("leaves a reference as it is", () => {
    expect(one(`x ${E}`, "leave")).toBe(`x ${E}`);
  });

  it("changes several in one text, each as chosen", () => {
    const body = `${E}\n\nAnd ${L} again.\n\n${E}`;
    const refs = referencesIn(src, body, ID);
    const out = rewriteAll(body, [{ link: refs[0]!.link, choice: "remove" }, { link: refs[1]!.link, choice: "text" }, { link: refs[2]!.link, choice: "leave" }], asText);
    expect(out).toBe(`And my favourite line again.\n\n${E}`);
  });
});
