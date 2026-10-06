# 0066. Boards elsewhere: shown in notes, and exported

- Status: accepted
- Date: 2026-10-05
- Request: R-057 (boards, phase 5 of `docs/plans/boards.md`)

## Context and problem

A board should be usable outside its own page: shown in the notes that discuss it, and sent or
kept as a picture or a file. Excalidraw's own exports would show cards as empty frames, and
pictures are kept by ID only (0065), so a board doesn't read outside the app on its own.

## Decision

- **In a note,** `![[Board|id]]` shows the board as a picture: an SVG drawn from its saved
  drawing in the app's look, with its name as a caption. A click opens it. It is drawn again
  when the board is saved, since note embeds follow the record's version. Export with
  quotations writes a link to the board's readable page.
- **Export** (File menu, on a board), after saving, to a place chosen in the save dialog:
  - as a picture, PNG at twice the size, or SVG;
  - as an Excalidraw file that reads anywhere.
- **To read anywhere** (all three):
  - Each card becomes a box with its words: a capture's quotation and citation, as the
    capture writes them for Export with quotations; any other record's name and kind.
  - Pictures are put back in from the library.
- `export.write` now also takes bytes in base64 (`data`), for pictures. Exports still never
  go into the library folder.
- The drawing code stays in the engine, loaded on demand. The page loads the whole engine
  module, its picture and file functions included, only when needed.

## Consequences

- An API test covers text and byte exports (bad base64 refused, never into the library).
- Interface tests:
  - a board in a note: its picture, its cards' words, the caption, opening it, its
    Markdown;
  - the three exports, saved first, and nothing written when no place is chosen;
  - cards' words.
- WebKit checks with the real Excalidraw: the SVG has the cards' words and the picture; the
  PNG is made; the Excalidraw file has no embed elements, its cards written out and its
  pictures inside.
- A board picture in a note is drawn when the note shows it; many large boards in one note are
  drawn one by one.
