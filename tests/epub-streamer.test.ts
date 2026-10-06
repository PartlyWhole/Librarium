import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { openBook, resolvePath } from "../src/reader/epub/streamer";

const bytes = readFileSync("tests/fixtures/library/notebooks.epub");
const urls: string[] = [];
const opts = { objectURL: (b: Blob) => (urls.push(b.type), `blob:test/${urls.length}`), revokeURL: () => {} };

describe("an EPUB served to Readium from memory (0045)", () => {
  it("describes the book: title, reading order, contents, positions", async () => {
    const book = await openBook(bytes, "item1", opts);
    expect(book.title).toBe("Notebooks");
    expect(book.publication.readingOrder.items.map((l) => l.href)).toEqual(["OEBPS/text/c0.xhtml", "OEBPS/text/c1.xhtml"]);
    expect(book.toc.map((t) => [t.title, t.href, t.depth])).toEqual([["Chapter One", "OEBPS/text/c0.xhtml", 0], ["Chapter Two", "OEBPS/text/c1.xhtml", 0]]);
    expect(book.publication.toc?.items.map((l) => l.title)).toEqual(["Chapter One", "Chapter Two"]);
    expect(book.positions.length).toBeGreaterThanOrEqual(2);
    expect(book.positions[0]!.locations.position).toBe(1);
    expect(book.fixed).toBe(false);
  });

  it("gives spine items the CFIs foliate-js gave them, so captures keep their places", async () => {
    const book = await openBook(bytes, "item1", opts);
    // package > metadata, manifest, spine: the spine is the third element (/6).
    expect(book.spine.map((s) => s.cfi)).toEqual(["epubcfi(/6/2)", "epubcfi(/6/4)"]);
  });

  it("serves chapters with the book's code made inert, the policy, and its path", async () => {
    const book = await openBook(bytes, "item1", opts);
    const res = book.publication.get(book.publication.readingOrder.items[0]!);
    const doc = (await res.readAsXML())!;
    expect(doc.querySelector("parsererror")).toBeNull();
    const script = doc.querySelector("script")!;
    expect(script.getAttribute("type")).toBe("application/x-librarium-inert");
    expect(script.textContent).toBe("");
    expect(doc.querySelector("[onerror]")).toBeNull();
    expect(doc.querySelector("a")!.getAttribute("href")).toBeNull();
    expect(doc.querySelector("meta[http-equiv=Content-Security-Policy]")!.getAttribute("content")).toContain("script-src blob:");
    expect(doc.querySelector("meta[name=librarium-href]")!.getAttribute("content")).toBe("OEBPS/text/c0.xhtml");
    expect(doc.body.textContent).toContain("Attention is the rarest");
  });

  it("finds chapter text for find", async () => {
    const book = await openBook(bytes, "item1", opts);
    expect(await book.chapterText("OEBPS/text/c1.xhtml")).toContain("Gravity and grace");
  });

  it("resolves paths inside the book and leaves the outside alone", () => {
    expect(resolvePath("OEBPS/text/c0.xhtml", "../images/a b.png")).toBe("OEBPS/images/a b.png");
    expect(resolvePath("OEBPS/text/c0.xhtml", "c1.xhtml#x")).toBe("OEBPS/text/c1.xhtml");
    expect(resolvePath("OEBPS/text/c0.xhtml", "https://example.com/x.png")).toBeNull();
    expect(resolvePath("OEBPS/text/c0.xhtml", "%E2%80%94.css")).toBe("OEBPS/text/—.css");
  });
});

describe("a richer EPUB: resources, nested contents, links, non-linear items", () => {
  const styled = readFileSync("tests/fixtures/library/styled.epub");

  it("serves resources as blob URLs (stylesheets with theirs rewritten) and never the book's scripts", async () => {
    urls.length = 0;
    const book = await openBook(styled, "s", opts);
    const doc = (await book.publication.get(book.publication.readingOrder.items[0]!).readAsXML())!;
    expect(doc.querySelector("img")!.getAttribute("src")).toMatch(/^blob:test\//);
    expect(doc.querySelector("link[rel=stylesheet]")!.getAttribute("href")).toMatch(/^blob:test\//);
    expect(doc.querySelector("p.pic")!.getAttribute("style")).toMatch(/url\("blob:test\/\d+"\)/);
    // The script file stays unloaded: its element is inert, and no blob was made of type JavaScript.
    expect(doc.querySelector("script")!.hasAttribute("src")).toBe(false);
    expect(urls.some((t) => /javascript/.test(t))).toBe(false);
    expect(urls).toContain("text/css");
    expect(urls).toContain("font/woff2");
    // Links between chapters stay links (Readium navigates with them).
    expect(doc.querySelector("a")!.getAttribute("href")).toBe("two.xhtml#end");
    const css = await book.publication.get(book.publication.resources!.items.find((l) => l.href.endsWith("style.css"))!).readAsString();
    expect(css).toMatch(/src: url\("blob:test\/\d+"\)/);
  });

  it("keeps non-linear items in the reading order, where links reach them (notes; R-065), and in the spine (for CFIs)", async () => {
    const book = await openBook(styled, "s", opts);
    expect(book.publication.readingOrder.items.map((l) => l.href)).toEqual(["EPUB/text/one.xhtml", "EPUB/text/notes.xhtml", "EPUB/text/two.xhtml"]);
    expect(book.spine.map((s) => [s.href, s.linear, s.cfi])).toEqual([
      ["EPUB/text/one.xhtml", true, "epubcfi(/6/2[r1])"],
      ["EPUB/text/notes.xhtml", false, "epubcfi(/6/4[r-notes])"],
      ["EPUB/text/two.xhtml", true, "epubcfi(/6/6[r2])"],
    ]);
  });

  it("reads nested contents from the navigation document (not its landmarks)", async () => {
    const book = await openBook(styled, "s", opts);
    expect(book.toc.map((t) => [t.title, t.href, t.depth])).toEqual([["Part One", "EPUB/text/one.xhtml", 0], ["A Section", "EPUB/text/one.xhtml#s2", 1], ["Part Two", "EPUB/text/two.xhtml", 0]]);
    expect(book.publication.toc!.items[0]!.children!.items[0]!.href).toBe("EPUB/text/one.xhtml#s2");
  });

  it("reads an EPUB 2: contents from its NCX, and pages that aren't well-formed XHTML", async () => {
    const book = await openBook(readFileSync("tests/fixtures/library/old.epub"), "o", opts);
    expect(book.toc.map((t) => [t.title, t.href, t.depth])).toEqual([["The Only Chapter", "a.html", 0], ["Within", "a.html#in", 1]]);
    const doc = (await book.publication.get(book.publication.readingOrder.items[0]!).readAsXML())!;
    expect(doc.querySelector("parsererror")).toBeNull();
    expect(doc.getElementById("in")?.textContent).toBe("within");
  });
});
