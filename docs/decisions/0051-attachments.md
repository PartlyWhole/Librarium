# 0051. Images put into notes are kept in the Library's Attachments folder

- Status: accepted (extends 0040)
- Date: 2026-10-04
- Request: R-042 in `docs/REQUESTS.md`

## Context and problem

Images pasted or dropped into notes became library items at the Library's top level (0040),
mixed in with books and articles. The user wanted them kept apart, as attachments, with a way to
make one a standalone item. They suggested images only for now.

## Decision

- Images pasted into a note, or dropped on one, go into the Library's **Attachments** folder,
  created on first use (`library.importData` / `library.import` with `folder`). They are still
  ordinary library items: embedded in the note by ID, found by search, capturable.
- PDFs and EPUBs dropped on a note go to the top level, as before.
- **Move to the Library** (an item's menu; undoable) promotes an attachment: it moves out of
  Attachments to the top. Notes keep showing it, because they point at its ID.

## Consequences

- An interface test covers pasting (into Attachments), promoting, and Undo.
- Attachments can be organised like any folder (renamed, sub-folders); anything under it counts
  as an attachment.
