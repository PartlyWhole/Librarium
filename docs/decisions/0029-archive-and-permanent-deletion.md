# 0029. Archive and permanent deletion

- Status: accepted
- Date: 2026-10-03

## Context and problem

§6 and §8 (milestone 9): deleting is two steps. Archive first, then delete permanently only
with explicit confirmation. Archive and restore can be undone; permanent deletion can't.
Acceptance: nothing is deleted without the two-step confirmation.

## Considered options

1. Archiving moves the file into an `archive/` folder.
2. Archiving sets a field (`archive.at`) and leaves the file where it is.

## Decision

Option 2.
- **Archive:** sets `archive.at` (UTC time). Only that field's bytes change, so links,
  embeds and captures keep working, and it works the same for Markdown and JSON-folder
  records. A new interface slot, `shell.hiding-fields`, lets the Archive feature hide records
  with that field from every list and from search (search takes a `hide` list). Restore
  removes the field. Both go through `set_fields` with the expected version, so their Undo
  refuses if the file changed since.
- **Permanent deletion:** a kernel intent, `Delete`, written before any file is removed. It
  removes the record's own file first (the commit point), then its sidecars, or its whole
  item folder. A power cut mid-way is finished at the next start: the record and its files
  are all there, or all gone. Crash tests cover the in-memory fake and the real disk.
- **Two steps, enforced by the backend, not only by the interface:**
  - `archive.prepareDelete` refuses records that aren't archived. It returns every file that
    would go, plus a single-use token bound to each record's version, valid for five minutes.
  - `archive.delete` takes only that token. A record that changed or was restored since the
    preview is skipped.
- **Interface:** "Archive" and "Restore from archive" in the palette and File menu. The
  Archive page has Restore and "Delete permanently…" for each record, and "Delete all…".
  The confirmation dialog lists what goes and says it can't be undone, and Cancel is focused
  by default.

## Consequences

- An archived record still occupies its name and folder. Moving or renaming it works as
  usual.
- Restoring and archiving again within the same second writes identical bytes, so the
  version is the same. The confirmation then still covers it, which is correct: it is
  exactly what was confirmed.
- Known limit, found while testing: if FSEvents splits an outside move across two batches,
  the move is seen as a removal and then a creation, not a rename. The record keeps its ID
  either way. Tests now deliver a move's paths in one batch, as FSEvents coalesces them.

## Later (2026-10-03): a context menu

The user found no way to archive from the lists. Every record now has a context menu
(right-click, the menu key or ⇧F10) in the sidebar, on the Library page and on the Archive
page. It is built from a new interface slot, `shell.record-actions`. Archive contributes
"Archive", "Restore from archive" and "Delete permanently…". The last is offered only for
archived records and still opens the confirmation, so deleting remains two steps.
