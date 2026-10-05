# 0055. ⌘Z and ⇧⌘Z undo and redo moves, renames and archiving, several deep

- Status: accepted (extends 0017 and 0054)
- Date: 2026-10-05
- Request: R-051 in `docs/REQUESTS.md` (it also answers R-049's question)

## Context and problem

App actions had a single Undo, from the toast or the Edit menu, and no Redo. ⌘Z never reached
them. The user asked for undo and redo for moving files and folders around (in Notes and the
Library) and for archiving. They also asked to remove the Undo history view (0053).

## Decision

- `Undo` (`src/shell/undo.ts`) keeps a stack of up to 50 steps for the session, and a redo
  stack that a new action clears.
- Each step knows how to undo itself and, now, how to do itself again. It carries the versions
  its last run produced, so undo and redo still refuse a file that changed meanwhile (that
  step is then dropped). Steps with redo:
  - moving records and folders (drag, menu, the Files page), and arranging by hand;
  - renaming folders, notes, captures and items;
  - removing an empty folder;
  - archiving and restoring;
  - Move to the Library;
  - restoring a version.
- ⌘Z / ⇧⌘Z (Edit ▸ Undo / Redo) act on what has focus: a note's text, a text field, or
  anywhere else the app's actions. Inside a note, ⌘Z is always the note's text.
- The Edit menu also has Undo / Redo the last move, rename or archiving, which work from
  anywhere, the editor included. All of these are greyed out with nothing to do.
- Toasts offer Undo after an action or a redo, and Redo after an undo.
- The Undo history view is removed. Its editor hooks went with it; `editorChanged` stays for
  Edit ▸ Undo.

## Consequences

- Interface tests cover several undos and redos of archiving, redo of a drag move, and the
  Edit items (app actions away from text, the note's text inside a note).
- Permanent deletion still can't be undone.
