# 0068. Links in EPUBs are followed by the reader, and notes files are read

- Status: accepted
- Date: 2026-10-06
- Request: R-065 in `docs/REQUESTS.md`

## Context and problem

The user reported that EPUB footnotes don't work. In tests made with script-generated clicks,
they did. With real clicks, made by the WebKit runner the way a hand makes them, three things
went wrong:

- Readium decides on `pointerup` whether a click is a click, and drops it if the pointer moved
  more than one pixel. It also stops the browser's own following of the link. A footnote
  clicked with the slightest movement did nothing.
- A footnote number is small (`2`, about 5 pixels wide). Let go just off it, and the click
  belongs to the paragraph, not to the link.
- Spine items marked `linear="no"` were left out of the reading order. Many books mark their
  notes file that way, so links into it went nowhere.

Script-generated clicks hid all of this: Readium treats them as clicks regardless of movement.

## Decision

- **The reader follows links in the book itself** (in each page's frame, before Readium):
  - A link is followed when the pointer is let go within 8 pixels of where the link was
    pressed, including just off it.
  - A drag that selects text isn't followed.
  - Links to the web are asked about, as everywhere in the app (`open-link`).
  - Links into the book are resolved against the file the link is in, wherever that file is
    in the book's folders and whatever its name (spaces too), then shown, fragment included
    (`goHref`).
  - Readium no longer sees those clicks, so it can't follow a link a second time.
- **Every spine item is in the reading order,** non-linear ones too, where their links reach
  them. They also show in sequence when reading on, as most readers show them.
- **The WebKit runner can make real clicks** (`nativeClick` in `scripts/webkit-run.swift`:
  native mouse events, with a drag carrying its movement), so checks can click as a person
  does.

## Consequences

- WebKit checks use real clicks that move 3 pixels, on a test book shaped like the user's
  books (`footnotes.epub`):
  - a note several pages on in the same chapter, and its link back;
  - a note in a separate notes file, and its link back;
  - a note in a non-linear file with a space in its name;
  - a drag from a note number selecting text rather than following.

  All but the drag failed before the fix.
- The streamer test now expects non-linear items in the reading order. That's a deliberate
  change.
- Footnotes opened where the note is. The user then chose a popover, as Apple Books does
  (0069).
