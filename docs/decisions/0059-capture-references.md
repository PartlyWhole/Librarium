# 0059. A capture opens from a note, lists where it is used, and asks before deleting a used one

- Status: accepted
- Date: 2026-10-05
- Request: R-060 and R-061 in `docs/REQUESTS.md`

## Context and problem

A capture placed in a note (`![[…|id]]`) only opened from its pencil; the capture page didn't
say which notes used it; and deleting a capture sent it to the archive without a word about
the notes quoting it, which then showed "In the archive" (and, once deleted for good, "A
missing capture"). The user wants a click to open the capture, the page to list what uses it,
and to decide, for each place, what happens when it is deleted, with good UX.

## Options considered

- Deleting: (a) one choice for every place; (b) a choice per place (chosen, with "For every
  place" shortcuts); (c) refusing to delete a used capture until the notes are edited by hand.
- Doing the rewriting in the backend (a new API method) or in the interface with
  `records.save`. The interface was chosen: it is plain text work on parsers shared with the
  kernel by fixture, and `records.save` already merges with typing in an open note.

## Decision

- **Opening.** A click on a placed capture (not its citation or pencil) opens the capture;
  ⌘-click opens it in a new tab. The card reacts to hover. The citation still opens the source.
- **Used in.** The capture page lists, below "Your words", each note using it and each place
  (the line before a placed quotation, or a link's sentence); a click goes there. The Links
  view of the side panel also shows on capture pages. "Your words" is shorter on this page so
  the list stays close.
- **Deleting a used capture** (from any Delete: page, panel, Library menu, Captures page,
  highlight popover) opens a dialog: each place, grouped by note, with the line before it and
  the quotation (or the link's sentence, its words marked), and three choices:
  - **Keep as quoted text** (default; for a link, **Keep the words**): on its own line, a
    Markdown quotation with its citation, keeping the line's indentation, quote marks and
    list position; in a sentence, “quote” (citation). A picture becomes "[A captured picture]".
  - **Remove**: the line goes when nothing else is on it (and one blank line, if it stood
    between two); in a sentence, it and one space go.
  - **Leave in place**: unchanged; it shows as its source, `![[words]]` (ID hidden), until the
    capture is restored (amended 2026-10-05, R-063: an archived capture is never drawn).
  Each choice says what the place will become. "For every place" sets all at once. The button
  says how many notes change. Read-only files are left as they are.
- On Delete each note is read again; one whose references changed in between is left (with a
  message). Notes are saved with `records.save` (three-way merge with unsaved typing), then
  the capture is archived through `shell.archiver`. **One Undo** restores the capture and every
  note changed (each merged with later typing where it can). A capture used nowhere is
  archived as before.
- Code: `src/features/captures/references.ts` (finding and rewriting, pure),
  `src/features/captures/delete.ts` (dialog and applying), wiring in `captures/index.ts`.

## Consequences

- Captures are not archived several at once (R-062): the generic Archive action doesn't apply
  to captures, so a multi-selection can't archive them; each goes through its own Delete. To
  be revisited if the user asks for it.
- Captures archived with a folder (0057) still skip the dialog; their places show as source.
- An archived or missing record placed with `![[…]]` (a capture, or an image) shows as its
  source, `![[words]]`, ID hidden (`embedShown`, the live preview's `cm-embed-unshown`), and is
  drawn again as soon as it is restored (`refreshPreview`).
- Deleting for good from the archive does not ask again.
