# 0063. The board page: saving, drafts, changes from elsewhere, and ⌘Z

- Status: accepted
- Date: 2026-10-05
- Request: R-057 (boards, phase 2 of `docs/plans/boards.md`)

## Context and problem

A board (0061, 0062) is edited in Excalidraw on its own page. It must keep the brief's promises
for writing:
- no work lost (§2, §6);
- never merged silently (0017);
- ⌘Z on the page shown (0060).

Excalidraw has no undo call and keeps its history only while open.

## Decision

- **Saving.** A second after the last change, and when the board is closed or the app quits,
  the drawing and its readable page are saved together (`boards.save`). A draft of the drawing
  is kept in Application Support 0.3 s after each change, and let go once saved. Opening a
  board with a newer draft gives the drawing back, with a notice offering to discard it. Each
  feature's startup notice counts only its own drafts.
- **Pictures** are refused for now (the image tool is hidden, and pasting one says so). They
  will be library attachments (phase 4), not data inside the drawing.
- **Changed elsewhere.**
  - With nothing unsaved, the board shows the version on disk.
  - With unsaved changes, the save is refused. The other version is kept as a new board
    beside it, "<title> (version from elsewhere)". This one is then saved, and a notice
    offers to open the copy. Nothing is merged and nothing is lost.
  - A page written from another drawing is rewritten when the board opens.
- **⌘Z** (0060): the board is its record's place.
  - Each finished gesture (a shape drawn, moved, a text typed) is a "Drawing" step in that
    place, in order with the steps done on the page (renaming, Move to folder).
  - Undoing a Drawing step sends ⌘Z to Excalidraw. The key is marked (`passThrough` in
    `kit/keys.ts`) so the app's own shortcuts let it through, rather than taking it for
    another press.
  - Undo and redo changes are saved, not counted as new steps. A drawing loaded from disk is
    neither.
  - Leaving the board forgets its Drawing steps, since Excalidraw's history ends with it.
    The board's other steps stay.
  - A rename's undo expects the version the page last saved, so the board's own autosaves
    don't block it; a change from elsewhere does.
- **Keys.** On the canvas, as in the editor, only the app's reserved shortcuts win.
  Excalidraw's single-letter tools work.
- **Folders.** The interface's folder spaces hold the kinds the backend lists (notes and
  boards). Listing, dragging, Rename… and Move to folder… all treat boards as notes.

## Consequences

- Interface tests use a stand-in engine that sends keys back as the real one does:
  - made beside a note and listed with it;
  - saved with the page;
  - draft recovered;
  - changed elsewhere, with and without unsaved changes;
  - a stale page rewritten;
  - ⌘Z interleaving drawing and rename;
  - one undo per ⌘Z pressed. This fails without the fix.
- WebKit checks run the real Excalidraw:
  - loading isn't a step;
  - typing is one step;
  - ⌘Z undoes it and ⇧⌘Z redoes it;
  - the theme;
  - no network.
- Only the real app can show the native menu's ⌘Z and the dev app's behaviour on your library.
