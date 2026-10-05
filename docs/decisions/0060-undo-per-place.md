# 0060. Undo per place: each page keeps its own history while the app runs

- Status: accepted (the user chose each option, 2026-10-05, R-064); amends 0055 and brief §6
- Date: 2026-10-05

## Context and problem

⌘Z acted on what had focus: a note's text, or else one app-wide list of moves, renames and
archiving. Leaving a note lost its typing history. The user wants ⌘Z to act on the page being
looked at (a note: its edits; a capture: what happens to it; the Library and notes: deleting
and moving things), each page keeping its own history while the app runs, following common
practice.

## Options considered

Common practice: undo is scoped to what is being looked at (a document per window in macOS's
NSUndoManager; Finder keeps its own for file operations; a text field its own); per-document
history survives leaving and coming back while the app runs (VS Code, when the file is
unchanged), not across restarts; an action belongs to where it was done; Edit ▸ Undo names
the step. The user chose: one history per note (typing and the note's own actions together),
staying on a capture's page after deleting it, one shared Library & notes history, and
histories kept while the app runs.

## Decision

- **Places** (`src/shell/undo.ts`): `record:<id>` for a record's page, and `library` for the
  sidebar and the pages without a record (Library, Files, Captures, Archive). Each keeps up
  to 100 steps, and its own redo, which a new step in that place clears.
- **What ⌘Z acts on** (`src/shell/text-undo.ts`): a focused text field (search, a title): its
  own; the sidebar when it has focus, or when it was the part of the window last clicked
  (menus opened from it leave the focus nowhere): `library`; otherwise the page shown: its
  record's place, or `library`. An editor belonging to no page (the capture being made)
  undoes its own typing. ⌘Z / ⇧⌘Z are reserved, so in a note they go through the place too.
- **A note's history** interleaves typing and the steps done on its page (renaming from the
  title, Move to folder from its header, restoring a version), in order. Typing is a marker
  in the place's history; CodeMirror keeps the changes (`textHistory`, `onHistoryStep`, and
  an isolating effect so typing after an app step starts a new step). Changes from outside
  the editor (an outside edit, a restored version, a capture's places rewritten) are not
  typing steps (`replaceDoc` doesn't add them to the history); the step that caused them
  undoes them.
- **Kept while the app runs:** leaving a note keeps its typing history (CodeMirror's JSON);
  opening it again gives it back if the text is what it was, or forgets the typing steps
  (keeping the others) if it changed outside meanwhile. Nothing is kept across restarts.
- **A capture's history:** its words, renaming, and deleting. Deleting from its page stays
  there; the page redraws to say it is in the archive (with Restore), and ⌘Z there brings it
  back. Deleting from a source's page (the highlight popover, the Captures panel) belongs to
  that page; from the Library or the Captures page, to `library`.
- **Steps go to the place they were done** (`done(…, { scope })`, or `undo.within(scope, …)`
  for an action that records its step further down, like Move to folder).
- **Edit ▸ Undo / Redo name the step** ("Undo Typing", "Undo rename to “…”"). "Undo the last
  move, rename or archiving" stays, for the latest app step wherever it was done. A toast's
  Undo undoes the step it announced.

## Consequences

- Two tabs open on the same note share its place; the latest editor attached holds its typing.
- Editing a capture's selection (in the reader) is not yet an undoable step.
- The action registry keeps getters when copying actions (for the menu's names).
- The capture page redraws itself (the router doesn't render the same route twice); "This is
  the place" for a moved part, which relied on a redraw, now gets one.
