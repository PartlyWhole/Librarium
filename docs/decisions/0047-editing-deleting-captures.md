# 0047. Captures can be renamed and deleted; embeds sit inside list items and quotes

- Status: accepted
- Date: 2026-10-04
- Request: R-031 in `docs/REQUESTS.md`

## Context and problem

The user wanted to edit and delete captures, and reported that captures embedded in notes
looked wrong: an empty line above and below each, and misaligned in lists and quotes.

## Decision

- **Editing.**
  - The capture page's title is an input that renames the capture (`records.relocate`, with
    Undo), as a note's does. "Your words" were already editable.
  - The quotation stays exact, by design (the brief: captures are exact quotations anchored to
    their place); to quote differently, capture again.
  - Removing one part of a several-part capture is left for later: it would renumber region
    images on disk.
  - In a note, a capture's card shows **Edit** on hover, which opens it.
- **Deleting** moves a capture to the archive, with Undo: the first of the library's two steps
  (0029). It is deleted for good from the archive. It goes through the archive's own record
  action (`shell.recordActions.get("archive")`), so captures don't depend on the archive
  feature. Delete is offered:
  - on the capture page (header);
  - in a right-click menu on captures in the Library tree (also Open, Show in the source, Copy
    embed) and in the Captures panel;
  - in the popover when a book's or PDF's saved highlight is clicked.
  Archived captures leave the tree, the panel and the source's highlights. Notes that embed
  one show its source instead (amended by 0059).
- **Embeds** in writing are inline-blocks that fill the rest of their line (`.cm-embed`), with
  their own indent and white-space. They were blocks inside the line, which broke it into an
  empty line box before (the bullet or quote marker) and after, and inherited a list's hanging
  indent.

## Consequences

- Interface tests cover deleting from the popover, the page and the tree menu, renaming, Edit,
  and the archived label. The embed layout was checked by eye in the preview (lists, nested
  lists, quotes); jsdom can't measure layout.
