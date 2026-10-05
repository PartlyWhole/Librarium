# 0057. Deleting a folder archives what's in it

- Status: accepted (extends 0029 and 0033)
- Date: 2026-10-05
- Request: R-054 in `docs/REQUESTS.md`

## Context and problem

Only an empty folder could be removed. The user asked to delete folders with things in them,
after confirming that those things are archived.

## Decision

- **Delete folder** in a folder's menu (the sidebar, the Files page):
  - an empty folder is removed at once;
  - a folder with things in it asks first ("The N items inside go to the Archive…"), then
    archives every record in it and its folders, and removes the empty folders inside.
- Deleting never removes a file. Archived records keep their place (0029), so the folder stays
  on disk with them. The app hides a folder whose records are all archived (0033), so it
  vanishes, and comes back if one of them is restored. Deleting them permanently is still the
  Archive's second step.
- One Undo (and Redo) covers the whole step: the records are restored and the empty folders
  made again.
- The shell's folders don't know about archiving: the archive feature lends it through the
  `shell.archiver` slot. Without it, only empty folders can be deleted.
- A folder holding a read-only record isn't deleted (that record can't be archived).

## Consequences

- After the archived records are deleted permanently, the folder is empty on disk and shows
  again as an empty folder, which can then be deleted at once.
- Interface tests cover the empty folder, the confirmation (and Cancel), the archiving, the
  empty subfolder, and Undo / Redo.
