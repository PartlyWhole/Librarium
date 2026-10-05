# 0052. Show brings out a passage's lines, not a frame around it

- Status: accepted (refines 0047)
- Date: 2026-10-05
- Request: R-047 in `docs/REQUESTS.md`

## Context and problem

In PDFs, Show outlined the box around all of a text capture's lines with a purple frame. Saved
captures were drawn as a box per word, because word spans in a PDF's text layer have gaps
between them and boxes only joined across 2 px. The user expected one continuous highlight, as
a selection looks.

## Decision

- Boxes on one line join when the gap is no wider than a few spaces (2.5 × the line's height),
  both when a capture is made (`boxesIn`) and when one is drawn (`drawMarks` → `joinLines`).
  This also draws captures saved earlier, one box per word, as lines.
- Show on a text capture scrolls the passage to the middle of the view and brightens its own
  lines for about two seconds (`flashPlace`, `.place-mark`), then leaves the saved highlight.
- Regions (picture captures) are still outlined, as a frame is their shape.

## Consequences

- WebKit checks cover the joined lines (old per-word captures included) and Show without a
  frame.
- A line gap wider than 2.5 line heights (a column gutter) still splits a line.
