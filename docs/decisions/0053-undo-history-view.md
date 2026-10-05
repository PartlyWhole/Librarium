# 0053. A temporary Undo history view in the side panel

- Status: accepted (temporary)
- Date: 2026-10-05
- Request: R-049 in `docs/REQUESTS.md`

## Context and problem

The user wanted to see what ⌘Z works on, "only temporary", maybe as a side panel tab. Undo has
two scopes (brief §6). A note's text uses CodeMirror's history (⌘Z / ⇧⌘Z in the editor). App
actions (renames, moves, archiving, restores) keep one undo, offered by the toast and by
Edit ▸ Undo the last rename or move. Neither was visible.

## Decision

- An **Undo history** view in the side panel (the ↶ tab), on every page. It has two parts:
  - **This note's text** (on a note page): the steps ⌘Z would undo, newest first, and below
    them what ⇧⌘Z would redo. They are read from CodeMirror's own history, by walking its
    stored inverse changes back from the current text, so the list is exactly what the keys
    do, grouping included.
  - **Renames, moves, archiving**: this session's app actions, newest first, with the time and
    whether they can still be undone. Only the latest can, and it has an Undo button.
- "Temporary" is taken two ways:
  - nothing is stored, so the log ends when the app quits;
  - the view is self-contained (`src/features/undo-history/` plus one line in `main.ts`), with
    small hooks in the shell's `Undo` (`log`) and the editor (`editorChanged`, `editorOn`,
    `textHistory`). Removing the feature leaves those harmless.

## Consequences

- Interface tests cover the text steps (undo and redo) and the app-action states.
- The log keeps at most 100 app actions per session.
