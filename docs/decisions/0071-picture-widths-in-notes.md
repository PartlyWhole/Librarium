# 0071. A picture's width in a note is kept after its embed: `{width=320}`

- Status: accepted
- Date: 2026-10-06
- Request: R-067 in `docs/REQUESTS.md` ("I want to be able to resize images in notes")

## Context and problem

Images (and boards) shown in a note were always drawn at their own size, up to the column's
width. A width belongs to the place where the picture is shown: the same image can be small in
one note and large in another, so it isn't a property of the library item.

The link grammar is fixed by the brief (§5.4): the ID follows the last `|`. A width can't go
inside the brackets: `![[chart|id|300]]` would not parse as a link. And the label is a cache
rewritten by the repair job, so a size in it would be lost.

## Decision

- **The width is written right after the embed, in Pandoc's attribute form:**
  `![[chart|id]]{width=320}` (pixels). Pandoc reads it the same way for images, the kernel's
  link parser is untouched, and "Export with quotations" keeps it after the image
  (`![chart](…){width=320}`).
- **It is hidden with the embed** while the picture is drawn, and shown as source on the line
  being edited, as the embed itself is.
- **A corner handle sets it:**
  - drag the bottom-right corner (shown on hover): the width is written when you let go, one
    undo step;
  - with the handle focused (it is a slider for VoiceOver), ← → make it 10% narrower or wider,
    Home the smallest, End its own size;
  - double-click the handle: its own size again (the attribute is removed).
- Widths stay between 48 pixels and the note's column. A width given again replaces the one
  kept.
- Which embeds can be resized is the renderer's say (`EmbedRenderer.resizable`): images and
  boards; capture quotations and item cards can't.

## Consequences

- Other Markdown apps show `{width=320}` as text after the embed (Obsidian included). The embed
  itself already shows as an ID there.
- The text `{width=320}` is part of the note's text for search and word counts; it is short.
