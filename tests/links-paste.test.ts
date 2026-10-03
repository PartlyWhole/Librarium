/** Pasting a list of links into "Save web pages…". */
import { describe, expect, it } from "vitest";
import { webAddresses } from "../src/features/library/index";

describe("web addresses in pasted text", () => {
  it("finds each http(s) address once, in order, and ignores everything else", () => {
    const text = "https://a.example/one\n\nnotes: see (https://b.example/two?x=1&y=2), then https://a.example/one again.\nftp://nope.example\nhttp://c.example/three.\n";
    expect(webAddresses(text)).toEqual(["https://a.example/one", "https://b.example/two?x=1&y=2", "http://c.example/three"]);
  });
  it("keeps encoded and unusual characters", () => {
    expect(webAddresses("https://x.example/Peter%20Thiel%20(transcript)")).toEqual(["https://x.example/Peter%20Thiel%20(transcript)"]);
    expect(webAddresses("(see https://x.example/a_(b))")).toEqual(["https://x.example/a_(b)"]);
  });
});

describe("pages already saved", () => {
  it("are recognised by the address given or the one redirected to, ignoring a trailing slash and #fragment", async () => {
    const { savedAddresses, normalizeAddress } = await import("../src/features/library/index");
    const items = [
      { fields: { provenance: { source: "https://a.example/post/", "final-url": "https://a.example/post" } } },
      { fields: { provenance: { source: "http://short.example/x", "final-url": "https://long.example/article" } } },
      { fields: {} },
    ] as never;
    const saved = savedAddresses(items);
    const known = (u: string) => saved.has(normalizeAddress(u));
    expect(known("https://a.example/post#comments")).toBe(true);
    expect(known("https://long.example/article/")).toBe(true);
    expect(known("https://a.example/other")).toBe(false);
  });
});
