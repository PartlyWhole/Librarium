# 0050. A scan's recognised text is put on the words seen; quotations read as text

- Status: accepted
- Date: 2026-10-04
- Request: R-045 in `docs/REQUESTS.md`

## Context and problem

In a JSTOR article, a scan with recognised text:
- selections and capture highlights didn't match the printed words;
- "Show" missed;
- quotations kept the page's line breaks and end-of-line hyphens.

The page is a picture with the text over it invisibly (render mode 3). Each line of the text is
one string in a font unrelated to the scan (Code2000), with no positions inside it, and about 5%
shorter than the printed line. The PDF doesn't say where the words are, so no reading of it can
place them.

## Decision

- **The picture is the ground truth.** On pages whose text is invisible (detected from the
  drawing operators), each line of the text layer is aligned to the ink under it
  (`src/reader/pdf-ink.ts`):
  - along a band through the line, the printed words are runs of dark columns separated by
    word-sized gaps;
  - the printed line is the run nearest the text's start, then the runs within a quarter of the
    text's length past its end, with no column-sized gaps;
  - each word goes on its run of ink when the counts agree; otherwise the line is stretched
    from its first ink to its last (not onto ink of a very different length).
  It runs after a page and its text are drawn, and again after a zoom. Selections, find,
  captures' stored positions and "Show" all follow.
- **Quotations read as text** (`src/kit/flow.ts`): inside a paragraph, line breaks become spaces;
  a word hyphenated across a line is rejoined; a hyphen before a capital stays; a dash at a line
  end joins without a space; paragraph breaks stay. This applies to new captures' quotes, and to
  showing older ones (cards, the capture page, panels, export). The exact quote that anchors a
  capture is unchanged. A PDF selection's text keeps its line ends (the text layer's `<br>`s).

## Consequences

- A WebKit check on a scan-like fixture (invisible monospaced lines, 8% short, over
  word-shaped ink): all 96 words land within 1.5 pt (0.2 pt in practice); before, 12 did.
  Checked on the user's article in the real WebKit view: every line highlighted exactly to its
  end.
- Rejoining hyphens is a heuristic: a lowercase compound split at a line end ("well-" +
  "known") is joined as "wellknown".
- Captures made before this keep the boxes they were saved with; edit or recapture to fix one.
