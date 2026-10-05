import { describe, expect, it } from "vitest";
import { flowQuote } from "../src/kit/flow";

describe("a quotation as it reads (not as the page laid it out)", () => {
  it("joins lines, rejoins words hyphenated across a line, and joins dashes", () => {
    const page = "Dionysus versus the \"Crucified\": there you have the antithesis. It is not\na difference in regard to their martyrdom—\nit is a difference in the\nmeaning of it. In the other case, suf-\nfering—the \"Crucified as the innocent one\"—counts";
    expect(flowQuote(page)).toBe("Dionysus versus the \"Crucified\": there you have the antithesis. It is not a difference in regard to their martyrdom—it is a difference in the meaning of it. In the other case, suffering—the \"Crucified as the innocent one\"—counts");
  });

  it("keeps paragraph breaks, and a capitalised word after a hyphen (a real compound)", () => {
    expect(flowQuote("First paragraph\nends here.\n\n  Second one\nstarts.")).toBe("First paragraph ends here.\n\nSecond one starts.");
    expect(flowQuote("the Indo-\nEuropean")).toBe("the Indo-European");
    expect(flowQuote("soft­\nhyphen")).toBe("softhyphen");
  });

  it("leaves flowing text as it is", () => {
    expect(flowQuote("Attention is the rarest form of generosity.")).toBe("Attention is the rarest form of generosity.");
  });
});
