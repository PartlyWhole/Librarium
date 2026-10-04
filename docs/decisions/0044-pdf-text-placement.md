# 0044. A PDF's selectable text lies exactly over the page, placed word by word

- Status: accepted
- Date: 2026-10-04
- Request: R-027 in `docs/REQUESTS.md`

## Context and problem

In PDFs (above all saved web pages), find highlights landed beside the words they matched,
mouse selection felt hard to aim, and a capture of several lines was highlighted on every
other line. Three causes:

1. **The text layer was larger than the drawn page.** PDF.js sizes the selectable text layer
   to the page box. Its default 9 px page border was meant to be removed by our stylesheet,
   but the rule targeted `.ws-page` (the shell's class), not PDF.js's `.page`, since
   milestone 5. Everything drifted outward from the corner, by about 2% across a page.
2. **Generic fonts.** PDF.js lays each run (often a line) out in a generic font, stretched to
   the run's width. Letters drift from the printed ones along the line, by up to half a letter
   in a web font such as Spectral.
3. **Lines merged.** A capture's boxes joined rectangles whose tops were within 0.5% of the
   page height. A saved web page is one very tall page, where that is more than a line.

## Decision

- The page border is removed with PDF.js's own option, `removePageBorders: true`. The style
  rule targets `.pdf-container .pdfViewer .page`, because PDF.js's stylesheet loads after ours.
- Each page's text content is split into words, and each word is placed with the PDF font's
  own glyph widths (`src/reader/pdf-words.ts`, with `fontExtraProperties` turned on so PDF.js
  shares the widths and character maps). The text is unchanged: the pieces join back into
  the run, so find offsets and copying are unaffected. Runs it can't place stay whole.
- Selection boxes join only when they overlap vertically by more than half a line, in pixels.
- Following common reader practice, found by a short review of Books, Kindle, Zotero and
  PDF.js:
  - mouse selections snap to whole words;
  - find shows every match softly and the current one stronger, with a ring;
  - the selection uses the app's selection colour.
  PDF.js already handles dragging across gaps in WebKit (`endOfContent`).

Using the embedded fonts in the text layer was tried and rejected: they are subsets whose
character maps don't match the text, so letters fell back unevenly and highlights got worse.

## Consequences

- Find and selection land on the printed words. A WebKit check keeps the text layer exactly
  over the drawn page, and fails if a page border comes back.
- Twice as many text elements per page, which is fine in practice.
- Captures saved before this keep the boxes they were saved with (some show every other line).
