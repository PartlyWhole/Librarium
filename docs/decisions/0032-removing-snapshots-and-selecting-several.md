# 0032. Removing snapshots, and selecting several records

- Status: accepted
- Date: 2026-10-03

## Context and problem

Saving a page again adds a snapshot and keeps the old ones. After a saver bug, 233 pages
needed saving again, and the user wanted a way to remove the faulty older snapshots, for
many pages at once.

## Decision

- **Removing snapshots is two steps,** like permanent deletion:
  - `library.removeSnapshots.prepare` lists what would go and returns a single-use token
    bound to each item's version.
  - `library.removeSnapshots` takes only that token.
  - `record.json` is rewritten first. The snapshot folders are removed after, so a crash in
    between leaves only unlisted folders.
- **What is never removed:**
  - **An item's last snapshot.**
  - **A snapshot another record uses.** Features declare which parts of a record their
    records use through a new kernel slot, `kernel.part-users`. Captures declares the
    snapshot each capture was made from. The Library feature asks the slot, without knowing
    about captures.
- **Where:**
  - "Remove older snapshots…" (keeps the latest) in a record's context menu, for one page or
    many.
  - "Snapshots…" in the reader of a saved page, to tick exactly which to remove.
  - Each opens one confirmation, with Cancel as the default button.
- **Selecting several:**
  - The sidebar tree, the Library page and the Archive page select several items with the
    Mac's conventions: ⌘-click, ⇧-click, ⇧↑/⇧↓, ⌘A in lists, and Escape.
  - Lists are multi-selectable listboxes (the APG pattern).
  - A context menu on a selected item acts on the whole selection. `shell.record-actions`
    entries take a list and a label that can name the count.
  - Archiving or restoring several records gives one Undo.
- **Job queue:** jobs created in the same millisecond run in the order of their IDs.
