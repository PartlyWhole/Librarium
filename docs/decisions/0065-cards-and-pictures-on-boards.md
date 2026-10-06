# 0065. Captures, notes, items and pictures on boards

- Status: accepted
- Date: 2026-10-05
- Request: R-057 (boards, phase 4 of `docs/plans/boards.md`)

## Context and problem

The point of boards is putting research on them: captures as quotations that stay true to
their source, and notes, items and pictures, all by reference. The drawing file should stay
plain and not swallow copies of pictures already kept in the library (plan §4, 0062).

## Decision

- **Cards.** A capture, note, item or board goes on a board as an Excalidraw embed element.
  - Its link is `librarium://record/<id>`, and it keeps `customData.librarium.links`.
  - Its contents are drawn by the app (`renderCard`), with the same renderers that show
    embeds in notes (`shell.embeds`). A capture shows its quotation, with parts joined by
    `[…]`, its citation and Show in the source. Other records show icon, name and kind.
  - It is drawn again when its record changes.
  - A record that's gone says so; one archived says "In the archive".
  - Only the app's own records can be cards: no web pages, videos or posts
    (`validateEmbeddable`).
  - Excalidraw's element builder doesn't make embed elements, so cards are built from their
    fields and completed by Excalidraw's own file reader (`restoreElements`).
- **Pictures** are library items (pasted ones are attachments, as in notes, 0051).
  - On a board, a picture is an Excalidraw image whose file ID is the item's record ID.
  - The saved drawing keeps the ID, not the picture's data. It's loaded from the library
    (`readBytes`) when the board opens.
  - Excalidraw's own image button stays hidden, so every picture comes from the library.
- **Ways in:**
  - **Put on the board…** (⌥⌘I; Edit menu) with the title picker;
  - dragging records from the sidebar or a folder page;
  - pasting a picture;
  - dropping files from Finder.

  Paste and drop use the library's protocol for notes (`librarium:files` in,
  `librarium:insert-embeds` back). The board's canvas is marked `data-takes-embeds`, and the
  library now looks for that as well as a note's editor. Things go on centred where they were
  dropped, or in the middle of the view, as one step to undo.
- **In the readable page,** a capture's card and a picture are written as embeds,
  `![[name|id]]`, as in notes. Other cards are written as links. So a capture's "used by"
  list, its backlinks and Export with quotations include boards.
- Whether a record is a picture is read from the library's `library.format` field. It's a
  known field, read, not a dependency on the library feature.

## Consequences

- Interface tests:
  - a capture's card through Put on the board…, written `![[…]]`, and redrawn when the
    capture changes;
  - a note's card opening it;
  - a missing record;
  - a pasted picture becoming an attachment and going on the board;
  - a note dragged from the sidebar.
- WebKit checks with the real Excalidraw:
  - a card shows the app's DOM;
  - a picture goes on by ID;
  - the saved drawing has no picture data.
- A board opened at excalidraw.com shows its cards as empty frames and its pictures as
  missing. "Export as Excalidraw" with the pictures inside is phase 5.
- A card is interactive once selected and clicked again (Excalidraw's rule for embeds). Its
  link marker opens the record at once.
