# 0035. Daily notes are ordinary notes

- Status: accepted
- Date: 2026-10-03

## Context and problem

Daily notes were shown apart: a "Daily notes" group in the sidebar, and a group entry on the
Notes page that opened like a folder but could hold no folders. The user wanted no special
group. A daily note should land at the top level of Notes and be treated like any other note,
while still knowing it is a unique daily note (for a view of all of them later, say).

## Decision

- **A daily note is a note with `daily.date`.** The backend already made it at the top level
  of `notes/`, one per day.
- **The ribbon's Today** (⇧⌘D) opens today's note, making it first if needed. That was already
  so.
- **The group is gone everywhere:**
  - from the Notes sidebar tree and the Notes page;
  - from the shell, which loses the `notes.groups` slot and the browser's groups and hidden
    records (no one else used them).
- **Daily notes sort, move, arrange and archive like any note.** Their field stays, so a
  special view of them can be built on it.

## Consequences

- Daily notes are listed by title (their date, `2026-10-03`), so they sort by day among the
  other notes.
