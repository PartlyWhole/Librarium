# 0025. How captures anchor, and how places are found again

- Status: accepted
- Date: 2026-10-03

## Context and problem

§5.5 fixes the model (W3C selectors, positions in code points into stored extracted text,
three steps to find a place again, "moved" above a score, "lost" below) and leaves the details.

## Decision

- **Where:** anchoring lives in `src/kit/anchor.ts`, so the reader, the captures panel and
  the capture page share it. Positions are code points into a record's stored text as the
  kernel gives it (`records.text`): a PDF's pages, or an EPUB's chapters, joined by blank
  lines, with a segment per page or chapter. A capture's selection is looked for within its
  page's segment, so a phrase repeated on another page isn't picked by mistake.
- **Finding again:** (1) the position, if the quote is exactly there; (2) the exact quote with
  whitespace collapsed (a reflow), unique or the only one whose context matches; several
  equal candidates are "moved", not "found"; (3) Hypothesis's fuzzy scoring (quote 50,
  prefix 20, suffix 20, position 2) with `approx-string-match`. A match scoring at least 0.75,
  whose quote is at least 70 % intact, is "moved"; anything else is "lost".
- **Confirming:** "This is the place" rewrites the part's quote and position selectors to the
  text now at that place; the user did it, so it isn't silent.
- **Regions** (PDF pages, images) are `xywh=percent:` fragments, refining `page=N` for PDFs,
  and keep a PNG of the region beside the capture. Geometry needs no re-anchoring.
- **The quotation** is also in the capture's frontmatter (`captures.quote`), so a capture
  reads without the app; the body is the user's own words.
- The fixture set (`tests/fixtures/anchors.json`) covers inserting before, after and inside a
  paragraph and inside a quote, reflowing, deleting, rewording and duplicating text. The
  test asserts that every found or moved anchor overlaps where the text actually went, and
  that "found" means the quote is exactly there.

## Consequences

When an extractor changes, captures stay anchored through steps 2 and 3, or say they're lost.
