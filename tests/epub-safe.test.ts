import { describe, expect, it } from "vitest";
import { BOOK_CSP, isMarkup, neutralize, parsePage, safeMarkup } from "../src/reader/epub-safe";

const XHTML = "application/xhtml+xml";
const page = (body: string, head = "") => `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>T</title>${head}</head><body>${body}</body></html>`;

describe("book pages are made safe before they are shown (0043, 0045)", () => {
  it("makes everything that could run inert, and keeps the text", () => {
    const out = safeMarkup(
      page(
        `<p onclick="x()">Attention <a href=" java\tscript:x()">here</a> <a href="#n">note</a></p><script src="app.js">x()</script><iframe src="a.html"/><object data="a.swf"/><embed src="a.swf"/><img src="i.png" onerror="x()"/><svg xmlns="http://www.w3.org/2000/svg"><a href="javascript:x()"><text onload="x()">s</text></a></svg>`,
        `<base href="https://example.com/"/><meta http-equiv="refresh" content="0;url=https://example.com"/>`,
      ),
      XHTML,
    );
    expect(out).not.toMatch(/<base|refresh|onclick|onerror|onload|javascript|app\.js|x\(\)|a\.html|a\.swf/i);
    expect(out).toContain("Attention");
    expect(out).toContain('href="#n"');
    expect(out).toContain('src="i.png"');
  });

  it("keeps script elements in place (empty, of a type nothing runs), so CFI paths don't move", () => {
    const doc = parsePage(page("<p>one</p><script>x()</script><p>two</p>"), XHTML);
    neutralize(doc);
    const kids = [...doc.body.children];
    expect(kids.map((k) => k.localName)).toEqual(["p", "script", "p"]);
    expect(kids[1]!.getAttribute("type")).toBe("application/x-librarium-inert");
    expect(kids[1]!.textContent).toBe("");
  });

  it("gives every page the policy (scripts only from the reader's blob URLs), first in its head", () => {
    const doc = new DOMParser().parseFromString(safeMarkup(page("<p>x</p>"), XHTML), XHTML);
    const meta = doc.head.firstElementChild!;
    expect(meta.getAttribute("http-equiv")).toBe("Content-Security-Policy");
    expect(meta.getAttribute("content")).toBe(BOOK_CSP);
    expect(BOOK_CSP).toMatch(/^script-src blob:;/);
    expect(BOOK_CSP).toContain("object-src 'none'");
  });

  it("reads broken XHTML as HTML, as readers do", () => {
    const out = safeMarkup("<html><head></head><body><p>Unclosed<br><script>x()</script></body></html>", XHTML);
    expect(out).not.toContain("x()");
    expect(out).toContain("Unclosed");
    expect(out).toContain("Content-Security-Policy");
  });

  it("knows which resources are markup", () => {
    expect(isMarkup("application/xhtml+xml")).toBe(true);
    expect(isMarkup("text/html; charset=utf-8")).toBe(true);
    expect(isMarkup("image/svg+xml")).toBe(true);
    expect(isMarkup("text/css")).toBe(false);
    expect(isMarkup("image/png")).toBe(false);
  });
});
