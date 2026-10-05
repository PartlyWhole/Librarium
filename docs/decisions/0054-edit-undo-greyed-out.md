# 0054. Edit ▸ Undo and Redo are the app's own, greyed out with nothing to undo

- Status: accepted
- Date: 2026-10-05
- Request: R-050 in `docs/REQUESTS.md`

## Context and problem

Edit ▸ Undo and Redo were macOS's built-in items, which the app can't enable or disable: they
looked available with nothing to undo. The user asked for them to be greyed out and blocked
then.

## Decision

- Undo (⌘Z) and Redo (⇧⌘Z) are actions in the registry (`edit.undo`, `edit.redo`), first in
  the Edit menu. They act on what has focus (`src/shell/text-undo.ts`):
  - **a note:** CodeMirror's history. They're on only when it has a step (`undoDepth`,
    `redoDepth`).
  - **a text field:** the field's own undo (`execCommand`). They're on while it has focus,
    since a field doesn't say how much it can undo.
  - **anything else:** greyed out, and ⌘Z does nothing.
- App actions keep their own item, Undo the last rename or move, also greyed out with nothing
  to undo. Whether ⌘Z should undo them outside text is still a question for the user (R-049).
- The menu is installed again only when one of those on/off states flips, not on every
  keystroke.

## Consequences

- Cut, Copy, Paste and Select All stay built in.
- Undo in a contenteditable outside the editor (there are none now) would need adding here.
- Interface tests cover the menu entries and their enabled states in a note and a field.
- Only the real app can show the native menu greying out and ⌘Z going through it.
