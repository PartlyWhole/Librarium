# 0040. Images in notes are library items

- Status: accepted
- Date: 2026-10-03
- Request: R-021 in `docs/REQUESTS.md`

## Context and problem

A note needs images: pasted from the clipboard, or dropped from Finder. The two candidates
were library items (with an ID, shown in the Library, embedded with `![[title|id]]`) or plain
files in an `attachments/` folder (`![](attachments/x.png)`, readable by other Markdown apps).
The user chose library items.

## Decision

- **Pasting** an image (or a PDF or EPUB) into a note sends its data to `library.importData`,
  which stages it and imports it like any added file. The original is kept byte for byte, and
  the item has an ID. A clipboard image has no name, so it is called "Pasted image <date and
  time>".
- **Dropping** files from Finder onto a note imports them, through the window's file drop:
  Tauri gives the paths and the position, and the editor under that point gets the embed.
  Dropped anywhere else, files are added to the Library as before.
- **The note gets `![[title|id]]` on its own line,** where the image was dropped or at the
  cursor. The editor and the Library meet through DOM events: the editor sends
  `librarium:files` and receives `librarium:insert-embeds`, so neither imports the other.
- **An item embedded in a note** shows as the image itself (fit to the column, at most 70% of
  the window's height; a click opens it), or as a card for a PDF, page or book.
  "Export with quotations" writes an image as `![title](its original's path)`.
- **Pasted HTML that carries files** is left to this path, not converted to Markdown.
- Embedded images don't count as words.

## Consequences

- **The note stays plain Markdown with an ID link.** Another Markdown app shows `![[title|id]]`
  as text, not as the image (the trade-off the user accepted).
- **Images live in `items/` like everything in the library,** with history, folders and
  archive.
- **Not yet done:** resizing an image in a note.
