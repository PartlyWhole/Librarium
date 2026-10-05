# 0062. Boards on disk: a page and an Excalidraw drawing, beside notes

- Status: accepted (the user chose both on 2026-10-05, R-057: boards beside notes; the two-file
  format)
- Date: 2026-10-05

## Context and problem

Boards (`docs/plans/boards.md`) are whiteboards made with Excalidraw (0061). The brief wants
plain, open files readable without the app (§2). Structured data goes in JSON files paired
with the record by ID (§5.3). Links are `[[label|id]]` found by one parser (§5.4). The user
wanted boards beside their notes, and the format not guessed (§10).

## Decision

- **A new kind, `board`, kept in the Notes folders.** Kinds may now share a top folder when
  they are stored the same way (format, slugs, subfolder field). The folder's first kind is
  its primary, so a file there that names no kind is a note.
  - Boards use the notes' folder field (`notes.folder`), since they are in the notes' folders.
  - Listing, counting, moving and removing folders cover every kind kept there.
  - `folders.list` gives one space per folder, with `kinds` listing what it holds.
- **Two files per board:**
  - `<id>-<slug>.md`: the record (`kind: "board"`), and a readable page written by the app
    from the drawing. It holds the board's texts, links and captures, so search, backlinks
    and other programs see what's on the board. Its first line, an HTML comment, says edits
    to it are replaced.
  - `<id>.excalidraw`: the drawing, in Excalidraw's own JSON format. It opens at
    excalidraw.com and in Excalidraw's apps.
- **Saving** (`boards.save`):
  - The record keeps the SHA-256 of the drawing its page was written from
    (`boards.scene-sha256`).
  - A save names the version and drawing it was based on, and is refused (a conflict, with
    what is there now) if either changed.
  - The drawing is written first, then the page. A save cut short leaves either the old
    pair, or the new drawing with a page that says it's stale (`stale_page` on load); the
    next save rewrites it. Never a page claiming a drawing that isn't there.
- **A Markdown record's sidecars (`<id>.*`) now go with it to another folder.** They move first,
  so redoing an interrupted move finishes it. Before, only folder moves carried them, which
  was enough for captures, since they never change folder.

## Consequences

- Tests:
  - Kernel: kinds sharing a folder (and refused when stored differently); one space;
    folder moves taking every kind; side files moved with their record (fails without the
    fix).
  - Boards crate: the two files, with unknown keys kept; both checks on save; a drawing
    changed outside; a newer board read-only; moves, renames and deletion taking the
    drawing; a save interrupted at every step.
- Version history (0038) keeps the page, not yet the drawing. That's for phase 2.
- Excalidraw's file keeps images inside it as data. Boards will refer to images as library
  attachments instead (phase 4); "Export as Excalidraw" will write a self-contained copy.
