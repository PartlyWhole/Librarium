# 0031. Making captures: a panel beside the document

- Status: accepted (supersedes the capture dialog of milestone 6)
- Date: 2026-10-03

## Context and problem

Feedback from the user: a capture in several parts ("Some text here […] other text") needed
the capture button pressed twice. The dialog closed between parts, so the parts already
taken were no longer visible. Region capture barely worked.

Region capture had three faults:
- The drag layer was placed inside the scrolling document, so once the user scrolled down it
  was no longer on screen, and the drag selected text instead.
- A mouse release outside the layer was lost.
- The picture was cropped from the on-screen canvas: blurry, or from the wrong canvas when
  zoomed.

## Decision

- **A button by the selection.** When a selection ends (mouse or keyboard), a small button
  appears under it: "Capture", or "Add to capture" once one is being made. ⇧⌘C and the
  toolbar button do the same.
- **The capture being made waits in a panel beside the document**, not a dialog, so reading
  and selecting carry on. It shows:
  - every part, with […] between them, each removable
  - the citation
  - the user's words
  - Save (⌘↩) and Discard
- **Parts read in the source's order** (page, then position), whatever order they were
  picked in.
- **Every part is highlighted in the document** while the capture is being made (PDF, image
  and EPUB, the last through foliate's overlayer). Highlights are measured inside the page's
  border, so they sit exactly on the text.
- **Regions** (toolbar or ⇧⌘R):
  - The drag layer is fixed over the visible document, wherever it is scrolled. The wheel
    still scrolls, the drag follows the mouse outside the layer, and Escape cancels.
  - A PDF region is rendered afresh from the page at up to about 2,000 px across, never below
    twice its natural size, so the picture is sharp.
  - Regions and text can be mixed in one capture.
- **Drafts are kept per source** (and snapshot) while the app runs. Leaving the item and
  coming back finds the capture as it was.
- Parts are joined with " […] " in a capture's quote.

## Consequences

- Reader engines offer `watchSelection`, `clearSelection` and `setMarks`. Selections carry
  their boxes and the position of their last line.
- Reader tools get an `aside` column. The reader page hides it while it is empty.
- Saved captures are not yet highlighted in the document. That would need their boxes
  stored with the anchor. The side panel lists them.
