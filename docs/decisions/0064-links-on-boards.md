# 0064. Links on boards

- Status: accepted
- Date: 2026-10-05
- Request: R-057 (boards, phase 3 of `docs/plans/boards.md`)

## Context and problem

A board must link to records as a note does:
- effortless to make;
- by ID, so renames and moves break nothing;
- found by backlinks (BRIEF §2, §5.4).

Excalidraw gives each element one link (a URL) and no links inside a text's words. Links must
also survive in the drawing file, which other programs open.

## Decision

- **On the drawing:**
  - An element linked to a record has the link `librarium://record/<id>` (Excalidraw follows
    it).
  - Each link it holds is kept as `{ id, label }` in its `customData.librarium.links`.
  - A text may hold several, each shown by name; a click follows the first.
- **Making links:**
  - `[[` typed in a text finishes the text and opens the title picker. Picking replaces
    `[[` with the record's name and links the text.
  - **Link to…** (⌥⌘K; Edit ▸ Link to a note or item…) links what's selected.
  - Each is one step to undo.
  - ⌘K stays Excalidraw's own link to a web address, since ⌘K is Format ▸ Link in notes.
- **Following links:** a click on a record link opens it, in a new tab with ⌘. A web link asks
  first, as everywhere in the app.
- **In the readable page,** links are written `[[name|id]]`, with the records' names as they
  are now:
  - in a text, where their names are, in order;
  - a linked shape's words are wrapped as its link;
  - a linked shape without words gets a line with its link.

  So the kernel's one parser finds them: backlinks, the Links view (now shown on boards too),
  and the links' repair job all include boards.
- **A page changed elsewhere with the same drawing** (the repair job refreshing names after a
  rename, or the page edited outside) isn't a conflict. The board's next save is based on the
  new version and rewrites the page, so no copy is made.
- `BoardElement`, `BoardLink` and the link helpers live in `links.ts`, without React. A
  dependency-cruiser rule (`board-engine-loads-on-demand`) allows the engine to be imported
  only on demand or for its types, so it stays out of the start-up bundle.

## Consequences

- Interface tests:
  - `[[` linking, with the record's backlinks listing the board;
  - Link to…, and a renamed record's name at the next save;
  - clicks (⌘ for a new tab; web links ask);
  - the page's link writing;
  - a page-only change not making a copy. This fails without the fix.
- WebKit checks with the real Excalidraw: `[[` reaches the page, and linking replaces it,
  re-measures the text and keeps the record's ID in the saved drawing.
- Excalidraw shows a record link's address (`librarium://record/…`) when hovered, not the
  record's name.
