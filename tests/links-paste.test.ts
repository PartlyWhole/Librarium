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
