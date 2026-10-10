# Librarium

A desktop app for one person to read, keep and write. It is a notebook and library for slow,
careful intellectual work: reading thinkers closely, quoting them exactly, and letting your own
ideas grow on top of what you read. It runs on a Mac (Apple silicon, macOS 15+). There are no
accounts, no cloud and no collaboration.

The file format is in [FORMAT.md](FORMAT.md); this file says what the app does and how it looks.

## Principles

| Principle | In practice |
|---|---|
| You own it, forever | All material is plain, open files in a folder the user chooses, readable without the app. |
| Research-grade rigour | Every quotation traces to its exact place in its source. A citation is never silently wrong. |
| Connection first | Linking is effortless, and links survive renames and moves (they point at IDs). |
| Never lose words | No write is lost, partial or silent. Unsaved text survives a crash. |
| Calm | Status messages and toasts. Dialogs only for conflicts and destructive confirmations. |

**Guarantees** (these are what the code must protect):
- **Writes.** Every write is a safe write. A save carries the version it was based on; if the file
  changed since, try a three-way merge, otherwise ask. Never overwrite silently, never re-create a
  file that has gone, never replace a read-only file.
- **Drafts.** About 300 ms after each change, the editor's text goes to a draft in app data. It
  is kept until the save succeeds, and drafts newer than their file are offered back at startup.
  Saves happen after 1 s idle, and on blur, navigation and close.
- **Multi-file operations** (rename, move, delete, repair) finish after a crash, or are undone. A
  crash never leaves two files claiming one ID.
- **Outside edits.** Edits made by other apps, while open or closed, are noticed. The indexes are
  disposable: deleting them rebuilds everything without re-running text recognition.
- **Deletion.** Nothing is deleted without two steps: archive first, then delete permanently
  with an explicit confirmation.

**Not now:** sync, accounts, mobile, plug-ins, AI features, a calendar, templates, duplicate
detection.

## Startup and quit

- **Window.** Single instance: a second launch focuses the window. The window's frame is restored.
- **Opening the library.**
  - The saved folder opens by itself, showing "Opening your library / Checking the folder for
    changes made while Librarium was closed…". The status bar shows "Checking…", then
    "N records".
  - **First run** shows the Welcome page: the mark and **Choose a folder…**.
  - **A non-empty folder** that isn't a library asks "Use a folder that already has files?"
    (**Choose another…** / **Use this folder**). Existing files stay, and Markdown in `notes/`
    becomes notes.
  - **iCloud Drive.** Once, the app says notes sync while the index and drafts stay on this Mac.
  - **Missing folder:** **Locate it…**, **Choose another folder…**, **Try again**.
  - **Failed open:** the error, with **Choose a folder…** and **Try again**.
- **After opening.** The saved tabs come back. With none, Today opens.
- **Recovery.**
  - Unsaved text is recovered with the toast "Text you hadn't saved was recovered" (**Show**), and
    the note offers **Discard it**. Boards recover the same way.
  - Interrupted jobs resume, with a note such as "Resumed 3 saves".
- **Quit.**
  - ⌘Q and closing the window (red button, ⇧⌘W) both save, close the library and quit.
  - Quitting from the Dock or at log-out exits at once; drafts survive.
- **Places.** File ▸ Show library folder in Finder; Help ▸ Reveal logs. Logs stay local, and
  panics are logged.

## Layout

One window. Only regions scroll, never the window.

```
┌──────┬──────────┬───────────────────────────────────┬────────────┐
│ribbon│ sidebar  │ tab bar                           │ side panel │
│ 44   │ 260      │ header 40: ‹ › · title · actions  │ 320        │
│      │          │ page (centred 700 px column)      │ (optional) │
├──────┴──────────┴───────────────────────────────────┴────────────┤
│ status bar 24                                                    │
└──────────────────────────────────────────────────────────────────┘
```

- **Ribbon:**
  - At the top, the sidebar toggle.
  - Then the pages: Today, Notes, Library, Captures, Search, Archive. The current page is in the
    accent colour.
  - At the bottom: Command palette, Keyboard shortcuts, Settings.
- **Sidebar.** A Filter box, then one tree with **Notes** and **Library** sections. Captures sit
  under their item, folded. Empty sections say "No notes yet." / "No library items yet.", and
  "Nothing matches" while filtering. Folding is remembered.
- **Header.** Back and Forward on the left; the title centred, small and muted; the page's actions
  and the side-panel toggle on the right.
- **Side panel.** Hidden at first. It shows one view at a time, chosen by icons along its top;
  only views that apply are shown, and the choice is remembered:
  - Links
  - Outline (notes)
  - History (notes)
  - Captures (items, captures)
  - About this item (items)
  - Jobs
- **Status bar.**
  - Left: messages, then running jobs (a button that opens Jobs; marked when something failed).
  - Right: the note's word and character counts (and the selection's), then
    "Checking…" / "N records".
- Every icon button has a spoken label and a tooltip with its shortcut.

## Tabs

- **Basics.** Each tab has its own back/forward history and keeps its page alive (scroll and
  place). Tabs are saved and restored.
- **No duplicates.** Opening something already in another tab switches to it, at the requested
  place.
- **New tab.** ⌘-click (links, embeds, cards, sidebar rows), middle-click, or "Open in new tab".
- **Closing.**
  - ⌘W closes a tab. The last one leaves a **New tab** page: "Open a note or library item…", the
    ribbon pages, and "Opened recently" (10).
  - ⇧⌘T reopens up to 20 closed tabs, with their history.
- **Tab bar.**
  - Click selects, middle-click closes, and dragging reorders.
  - Right-click: Close, Close other tabs, New tab, Move left, Move right.
  - On a focused tab: ←/→/Home/End move, Delete closes.

## Notes and the editor

- **Creating and naming.**
  - ⌘N makes a note beside the open note, or in the Notes folder being viewed, and focuses its
    title.
  - The title renames on blur, and the file name follows. Enter goes to the text; Escape reverts.
  - The header has **Move to folder**.
- **Editor.** CodeMirror 6 with Markdown live preview: marks are hidden except on the construct
  being edited.
  - **Markdown supported:** CommonMark plus GFM tables, tasks and strikethrough; `==highlight==`;
    quotes; fenced code. Code is highlighted for JS, TS, Python, Rust, JSON, CSS,
    HTML/XML/SVG, SQL and shell.
  - **Indented lines are never code.** Outside lists, Tab inserts a tab, ⇧Tab outdents and Enter
    keeps the indent. Away from the cursor, leading whitespace becomes a left margin (a tab is
    4 columns), so wrapped lines align. Fenced code, HTML and tables are left as typed.
  - **What shows away from the cursor.** Bullets are dots. Task boxes toggle on click. Bare URLs,
    `[sic]` and footnote marks stay visible. A web link opens on click (⌘-click while editing),
    after the web-link dialog.
- **Formatting.** These toggle, and are also in the Format menu:

  | Key | Format |
  |---|---|
  | ⌘B | bold |
  | ⌘I | italic |
  | ⇧⌘X | strikethrough |
  | ⇧⌘H | highlight |
  | ⌘E | code |
  | ⌘L | task |
  | ⌥⌘1–6 | heading (pressed again on that level, back to body text) |
  | ⌥⌘0 | body text |

  - ⌘K turns a selection into `[text]()`, or a selected URL into `[](url)`; with nothing
    selected it starts `[[`.
  - Typing `* _ = \` ~` over a selection wraps it.
- **Cursors.** ⌘D adds the next match, ⌥-click adds a cursor, and ⌥-drag makes a block selection.
- **Lists.** Tab / ⇧Tab move an item with its children and renumber the list, as one undo step,
  in quotes too. Enter continues the list. List indentation is written as spaces (tabs already
  there count as 4 columns), and a blank line Enter adds is empty. Wrapped lines hang under the
  text, items under a task line up with its text, and markers are drawn monospace.
- **Folding.**
  - An arrow appears left of headings and bullets, on hover or while folded. A folded line ends in
    "…" and its bullet gets a ring.
  - ⌥⌘[ / ⌥⌘] fold and unfold here; ⌃⌥[ / ⌃⌥] fold and unfold everything.
  - Folds are never written to the file.
- **Clipboard.**
  - Pasted HTML becomes Markdown; nothing runs and nothing is fetched.
  - ⇧⌥⌘V pastes plain text.
  - Copying gives other apps `[[label]]`; pasting back into Librarium restores the IDs.
- **Counts and outline.**
  - Word and character counts leave out IDs, URLs and marks, and embeds don't count.
  - The Outline panel lists headings, and clicking one goes there.
- **Read-only files** open read-only, with a notice.
- **Export with quotations…** writes a copy with every embed expanded:
  - captures as `> quote` plus `> — citation`
  - images as Markdown images
  - other records as links

### Links `[[…]]`

- **Inserting.** `[[` opens fuzzy suggestions over every openable record (up to 50). Picking one
  inserts `[[title|id]]`.
- **Display.** Only the label shows, as a link, except when the cursor is in or beside it; then it
  reads `[[label]]` with the ID hidden and skipped as one unit.
- **Opening.**
  - Click opens; ⌘-click or middle-click opens in a new tab.
  - While a link's source is showing, click places the cursor and ⌘-click opens; holding ⌘ makes
    it react to hover.
- **Unresolved links** (`[[Title]]`, no ID). Clicking creates that note beside the current one,
  completes the link, and opens the note.
- **Labels** are refreshed in the background after renames (aliases kept).

### Embeds `![[…]]`

- **Inserting.** `![[` offers captures, library items and boards.
- **How each kind shows** (except on the line being edited):

  | Kind | Shows as | Click opens |
  |---|---|---|
  | Capture | the quotation and "— Source, place" ("[…]" between parts, pictures on their own) | the quotation: the capture; the citation: the source at the place; a pencil on hover: the capture |
  | Image item | the image, resizable from its corner | it in the reader |
  | PDF, EPUB or web item | a card with icon and title | the item |
  | Board | a picture of the board, captioned with its name | the board |

  - ⌘-click opens any of these in a new tab.
  - A board's picture is redrawn when the board is saved.
- **Missing or archived records** show as `![[words]]`, with a tooltip. They are drawn again when
  restored.
- **Picture width.**
  - Dragging the corner writes `{width=N}`. Double-click returns to the picture's own size.
  - With the handle focused: arrows change the width by 10%, Home is the minimum (48 px), End is
    the picture's own size.
  - Resizing is undoable.
- **Paste and drop.**
  - Images go into Library ▸ Attachments and are embedded on their own line. Clipboard images are
    named "Pasted image <date time>", up to 50 MB.
  - Dropped PDFs and EPUBs go to the Library top level and are embedded as cards.
  - Anything else is refused.

### Outside edits and conflicts

- **An open note changes on disk.**
  - With nothing unsaved, it reloads.
  - With unsaved text, the next save tries a three-way merge.
  - If the changes overlap, a dialog "“X” changed outside Librarium" shows **Yours** and
    **On disk**, with **Keep yours** / **Use the version on disk** / **Keep both** (yours saved as
    "X (your version)").
- **A file that has gone:** "This note can't be found any more."
- **A conflict copy:** "Another copy of this note exists (…)" with **Compare**.
- **Notes deleted outside the app** are listed on the Archive page, with **Bring back** (from
  history).

## Daily notes

- **Today** (ribbon, ⇧⌘D) opens today's note, creating it if missing. A double press never makes
  two.
- If two notes share a date, the earlier one opens.
- **The day starts at 4 a.m.** by default (Settings: midnight to 6 a.m.), so writing after
  midnight lands on the day it belongs to.
- Daily notes are ordinary notes: they can be moved, renamed and linked.

## Folders: the Notes and Library pages, and the sidebar

- **Folder spaces.** Notes and Library each have their own folders, and boards share the Notes
  folders. Moving notes and items in one action is refused.
- **Pages.** Notes and Library are Finder-like folder browsers.
  - A path bar and a Filter box.
  - List view (Name, Kind, Date added, size) or icon view.
  - Sort by Name, Kind, Date added (either direction), or **As arranged**.
  - New folder (⇧⌘N), plus the header buttons: New note and New board on Notes; Save web pages
    and Add to library on Library.
  - Empty-folder hints.
- **Selection.** Click, ⌘-click, ⇧-click, box drag, or the keyboard.
- **Moving and arranging.**
  - Drag records and folders into folders (also onto sidebar folders and section headings).
  - Dropping on an edge places the item there and switches the folder to As arranged.
- **Menus.**
  - **Record:** Open, Open in new tab, Rename, Move to folder…, Move to the Library (attachments),
    Remove older snapshots… (web pages), Archive, Restore from archive, Delete permanently…
    (archived only). Destructive entries come last.
  - **Folder:** Open, Open in new tab, Rename…, New note inside and New board inside (Notes),
    New folder inside…, Move to…, Delete folder.
  - **Several selected:** "Move N items to…" plus the shared actions.
  - **Background:** New folder, Select all, View as icons/list, Sort by….
  - **Sidebar:**
    - Section headings: Open, Open in new tab, New note and New board (Notes), New folder….
    - Empty space: go to Notes or Library, or make a new folder in either.
    - Capture rows: Open, Show in the source, Copy embed, Delete.
- **Keys on a folder page:**

  | Keys | Effect |
  |---|---|
  | Arrows (⇧ extends) | move the selection |
  | Home / End | first / last entry |
  | Enter or ⌘↓ | open |
  | ⌘↩ | open in a new tab |
  | ⌘↑ | parent folder |
  | ⌘A | select all |
  | Escape | clear the selection |
  | Space | toggle selection |
  | F2 | rename |
  | ⌥ + arrows | move the selection by hand |
  | Typing | type-ahead |
  | Menu key / ⇧F10 | context menu |

- **Keys in the sidebar tree:**

  | Keys | Effect |
  |---|---|
  | ↑ / ↓ (⇧ extends) | move |
  | ← / → | fold, unfold, or go to the parent |
  | Home / End | first / last row |
  | Enter | open or toggle |
  | Typing | type-ahead |
  | Escape | clear the multi-selection |

- **Move to folder…** is a picker: type a folder's name; a new name is created on Return.
  Undoable.
- **Show in its folder** opens the folder with the record selected. **Rename…** asks for a title.
- **Deleting a folder.**
  - An empty folder goes at once.
  - Otherwise the app asks "Delete “X”?" — **Archive N items and delete** archives everything
    inside and removes the empty folders. It is undoable.
- Folders made in Finder appear when the window regains focus.

## Library

- **Adding.** Add to library… (File menu, Library header), or drop files anywhere.
  - Accepted: PDF, EPUB and images (png, jpg, jpeg, gif, webp, heic, tif, tiff).
  - Files go into the Library folder being viewed. A single import opens the item.
  - The original is kept byte for byte, with its sha256 and provenance.
  - Anything else is refused with a toast. There is no duplicate detection.
- **Text extraction** runs in the background, once.
  - PDF: PDFKit.
  - EPUB: its chapters. The book's own title replaces the file name unless the item was renamed.
  - Images, and PDF pages with fewer than 16 visible characters: Apple Vision (accurate mode,
    language correction, automatic language). Scans are rendered at about 200 dpi, at most
    4000 px.
- **Attachments.** Images pasted into notes and boards live in Library ▸ Attachments. **Move to the
  Library** promotes one to the top level; embeds keep working.

## Reader

### Common to every format

- **Toolbar.** Zoom out, Fit width, Zoom in (×1.2 steps, 0.25–8×); "Page N of M"; the capture
  buttons; a find field.
- **Find** (⌘F). Return / ⇧Return go to the next / previous match; "n of m" or "Not found"; Escape
  clears. Matches are soft yellow, and the current one is orange with a ring.
- **Going to a place.** Search hits and **Show in the source** go to the exact place without
  reloading. The passage is centred and brightened for about 2 s; regions get an outline.
- **Captures in the document.** Saved captures are drawn as soft highlights. Clicking one opens a
  popover with **Open capture**, **Edit** and **Delete** (one Open per capture where they
  overlap).
- **About this item** lists: Source, Author, Publication, Published, Saved, Saved with, Original
  file, SHA-256.
- Web links ask first (see Links to the web).

### PDF and saved web pages

- **Rendering.** PDF.js, served locally, including the JBIG2 and JPEG 2000 decoders. Internal
  links work.
- **Text layer.**
  - The selectable text lies exactly over the page, placed per word with the PDF's own letter
    widths. Drags snap to whole words.
  - Words whose ligatures PDF.js misreads ("diSerent", common in saved web pages) are corrected
    from the stored text, so find, selection and copying see "different".
  - Multi-line highlights are one band per line.
  - Before going to a place, the reader measures the pages up to it, so mixed page sizes never
    shift the target.
- **Scanned pages.** Recognised text is aligned to the printed words by reading the ink along each
  line, so selecting, find and Show follow the print.
- **Saved web pages** read as their snapshot's PDF.
  - A snapshot picker and a **Snapshots…** dialog appear when there is more than one.
  - Failed page checks show as notices ("About this snapshot: …").
- PDF reading position is not remembered.

### Images

The image is zoomable, with the recognised text laid over it as selectable lines. Regions can be
dragged out for capture.

### EPUB (Readium, in the manner of Apple Books)

- **Safety.** Book scripts never run, and fixed-layout books work.
- **Immersive page.**
  - The toolbar appears when the pointer nears the top, while it has focus, during find, or while
    a popover is open.
  - The running head shows the chapter. The foot line shows "N pages left in chapter" (or "Last
    page in chapter") and progress through the book.
  - The page colour fills the area. Side arrows show while the pointer moves.
- **Turning pages.**
  - ← → turn with a slide (reduced under Reduce Motion). Space / ⇧Space and PageDown / PageUp
    also turn.
  - A trackpad swipe turns one page, then swiping rests for 500 ms; momentum never turns more.
  - Keys pressed during a turn are queued.
  - Clicks never turn pages.
- **Contents** is a popover with the current chapter marked.
- **Aa panel.**
  - A− / A+ (0.6–2.5).
  - Layout: **Single page | Two pages | Scroll**. Two pages falls back to one when there isn't
    room, and says so. The same choices are in the menu: ⌃⌘1/2/3, which keep the first words on
    screen.
  - Themes: White, Sepia, Gray, Night, or match the app.
  - Fonts, each shown in its own face: Original, Athelas, Charter, Georgia, Iowan, Palatino, San
    Francisco, Seravek, Times New Roman.
  - Customise: line spacing (Book's, Tight, Normal, Loose), line length (Narrow, Medium, Wide),
    Justify.
  - Reset. Fixed-layout books say they can't be restyled.
- **Remembered.** Reading settings are per device, and each book reopens where it was left.
- **Links.** Followed when the pointer is released within a few pixels; a drag still selects.
- **Footnotes.**
  - A footnote reference opens a popover with the note (its back-link removed), plus
    **Go to note** and **Close**.
  - This covers chapter-end notes, separate notes files and empty-anchor notes.
  - Notes over 3000 words, and links that aren't notes, go to their place instead.
- **Find** searches the whole book.

## Captures

- **Starting a capture** on an item page:
  - Select text; a button appears: **Capture** ("Capture image" for a lone picture, or "Add to
    capture" while a draft exists).
  - ⇧⌘C captures the selection.
  - ⇧⌘R, or the crop button, drags a region (PDFs, saved pages, images): "Drag over the region to
    capture. Escape cancels."
  - Clicking a picture in an EPUB captures it.
- **The draft** sits at the top of the side panel's Captures view, which opens by itself.
  - It shows the parts as one quotation ("[…]" between them, × removes one), the hint "Select
    more text, or drag a region (⇧⌘R), to add to it", "From <citation>", and "Your words
    (optional)".
  - **Discard** / **Save capture** (⌘↩).
  - There is one draft per source and snapshot. It survives leaving and returning, and its parts
    are highlighted in place.
- **Saving** shows the toast "Captured." (**Open**).
  - Quotes read as flowing text: lines are joined, hyphenation rejoined, paragraphs kept.
  - If the stored text lacks the passage, the capture is kept with its page only, and the app
    says so.
- **The citation** is "Source, place". A place equal to the source's title is omitted.
- **The capture page.**
  - The archived notice, with **Restore**.
  - The title.
  - The quotation, with a Show button per part, "moved — check it" / "lost" badges, and
    **This is the place** for a moved part.
  - The "— citation" link.
  - **Your words** ("Write why this matters…").
  - **Used in**: each note and each place in it ("After “…”", "At the start"); clicking one opens
    the note there.
  - Header: Show in the source, Edit selection, Copy embed (`![[title|id]]`), Export as W3C
    annotations (`.jsonld`), Delete.
- **Editing parts** (Edit selection).
  - The source opens at the capture.
  - Text parts get word-snapped start and end handles. Regions get a frame to move or resize, and
    the picture is re-cut on release.
  - In an EPUB, holding a handle at the edge turns pages within the chapter.
  - Selecting more adds a part; × removes one. The panel row and a bar over the document offer
    **Cancel** / **Save changes** (⌘↩), and the toast is "Capture updated."
  - Your words and a user-given title are kept.
  - Editing parts is not undoable.
- **The Captures panel** shows the draft, then the source's captures, oldest first, with the open
  one marked and moved/lost badges. Each row offers Show, Edit selection, Copy embed and Delete.
- **The Captures page** (⇧⌘K).
  - Search by quote, name, source or place.
  - **By source** or **Newest first**; **All / Passages / Pictures**.
  - Cards show the quote or a thumbnail, name, source, place and date, with hover buttons.
  - A count. The view choices are remembered.
- **Deleting a capture that notes use** opens a dialog listing each place by note:
  - Embeds: **Keep as quoted text** (default), Remove, or Leave in place.
  - Links: **Keep the words**, Remove, or Leave the link.
  - "For every place" sets them all. The button reads "Delete and update N notes".
  - The capture is archived and the notes rewritten. One Undo restores everything.
- **Orphan sidecars** are listed in Settings ▸ Captures, never deleted.

## Links and backlinks

- **The Links panel** shows "Linked from", with context, for notes, items, captures and boards.
  For notes it also lists "Links without a target", with **Choose its target…**. It refreshes as
  the index updates.
- **Boards' pages count**, so backlinks and Used in include boards.

## Search

- **The page.** ⇧⌘F, searching every record, ranked by BM25 with the title weighted above the
  body.
- **Query syntax.** Words match by prefix; `"phrases"` match exactly; `-word` excludes a word.
- **Filtering.** Chips for Everything, Notes, Library and Captures, applied before the limit of 50.
  Archived records are excluded.
- **Results.** Each shows the title, kind and a snippet with the matches marked.
  - A hit opens at the passage: in a note, the cursor goes there; in an item, the reader does.
  - Passages are about 120 words, and titles alone are findable.
  - ↓ moves from the field into the results.
- **Performance.** Under 150 ms on 10,000 notes.
- **Rebuild index** is in the File menu and in Settings; it never changes your files.

## Boards

Boards use Excalidraw. React is used only here.

- **Creating.** New board (⌥⌘N) is made beside the current note or board, or in the viewed Notes
  folder, with its title focused. Boards are listed with notes.
- **The page.**
  - A title (renaming is undoable) and Move to folder.
  - The canvas follows the app's light or dark look.
  - A screen-reader list of what is on the board.
  - **Full screen** (⇧⌘↩, or the button at the canvas's top right): the drawing fills the screen
    and the rest of the app is hidden; the window goes into full screen, and comes out only if it
    wasn't there before. Pressed again, or on leaving the board, it ends.
  - Excalidraw's own Library (reusable shapes) is hidden: it isn't kept, and its name clashes
    with the Library.
- **Saving.**
  - The board saves 1 s after you stop, and retries with a message if saving fails.
  - If the board changed elsewhere: with nothing unsaved, the new version is shown. Otherwise the
    other version is kept as "… (version from elsewhere)" and yours is saved.
- **Undo.** ⌘Z / ⇧⌘Z undo drawing steps and renames, in order. Drawing steps are forgotten on
  leaving the board.
- **Linking.**
  - `[[` in a board text opens the title picker.
  - ⌥⌘K links the selection; ⌘K stays Excalidraw's web link.
  - Clicking a link opens the record (⌘-click: new tab). Web links ask first.
- **Putting things on the board.** ⌥⌘I, dragging from the sidebar, a folder page or the board's
  panel, pasting a picture, or dropping files.
  - **The panel.** A button at the canvas's top right (Captures and Library) opens two tabs, each
    newest first with one search box: **Captures** (searched by quote, name, source or place)
    and **Library** (by title, kind, folder, author or publication). Drag one onto the drawing,
    or Add (or Enter) puts it in the middle of what is in view. It docks beside the drawing on a
    wide enough canvas; the docking and the tab are kept while the app runs. Not on read-only
    boards.
  - Captures become cards with the quotation, the citation and Show in the source. They are
    redrawn when the capture changes.
  - Notes, items and boards become cards with their icon and name.
  - Pictures are library items (pasted ones go to Attachments).
  - A card's buttons work after selecting it and clicking again.
- **Export.** PNG, SVG, or an Excalidraw file (with its pictures embedded). Cards are written out
  as boxes with words.
- **Keys.** The app's reserved shortcuts win on the canvas; every other key goes to Excalidraw.

## Saving web pages

- **The dialog.** Save web pages… takes one or more addresses: Enter saves one, ⌘↩ saves a list.
  - It counts the pages, including those already saved, which are skipped unless "Save a new
    snapshot of those too" is ticked.
  - Pages go into the viewed Library folder.
- **How a page is saved.** One background job per address, through a hidden WebKit view
  (`WKWebView.createPDF`).
  - Each save produces a faithful PDF, clean text and provenance.
  - Popups are removed (late ones too), animations stilled, hidden text revealed, and the main
    text chosen. Web Crypto is hidden from the page.
  - Cancel stops a save at once.
- **Saving again** adds a snapshot, or makes a new item if the existing one is archived.
- **Page checks.** Error, not-found, paywall, verification, sign-in, drawn, incomplete, empty.
  The snapshot is kept, with notices. A page that never reached the web is never kept.
- **Removing older snapshots.** Two steps, listing what goes, and not undoable.
  - Every page keeps at least one snapshot.
  - Snapshots that captures came from are kept.

## Archive and deletion

- **Archiving** removes a record from lists, the sidebar, search and Captures. It is undoable,
  with Undo in the toast. Captures are deleted through their own dialog (see Captures).
- **The Archive page.**
  - Archived records, newest first, with **Restore** and **Delete permanently…**.
  - Select mode: ⌘A, Space, Select all / none, Done, Escape.
  - "Deleted outside Librarium", with **Bring back**.
- **Permanent deletion.** Only from the archive, after a confirmation stating how many files go.
  It cannot be undone and erases the record's history.
- **Embeds react at once.** An item archived or restored while captures from it are in use shows
  or hides those embeds immediately.

## Version history

- **What is kept.** Versions of notes, captures and boards, in `.librarium/history/`, safe with
  iCloud.
- **When a version is taken:**
  - at most every 5 minutes while writing in the app
  - on every outside change
  - before and after a restore

  The same bytes are never taken twice in a row.
- **The History panel** (⌥⌘Y, notes only).
  - Versions are labelled Edited here / Changed outside Librarium / Before a restore / Restored,
    with Current marked.
  - Each version shows its changes against the current text.
  - **Restore this version** (undoable) and **Copy its text**.

## Undo and redo

- **Per place.** Up to 100 steps per place, for the session:
  - Each record's page has its own history. A note's typing is interleaved with its renames,
    moves and restores.
  - One **Library & notes** history covers the sidebar and pages without a record: moves,
    renames, archiving, restoring, folders, arranging.
- **What ⌘Z acts on:**
  - a focused text field: its own text
  - a focused editor with no page (the capture draft): its own typing
  - the sidebar, when focused or last used: the Library history
  - otherwise: the current page's place
- **Across navigation.** A note's typing history survives leaving it. It is forgotten if the file
  changed outside in the meantime.
- **The Edit menu.** Undo and Redo are named after the step ("Undo Typing", "Undo rename to
  “…”") and greyed out when there is nothing to undo. **Undo/Redo the last move, rename or
  archiving** reaches the latest app action anywhere.
- **Safety.** App steps record the version they expect, and refuse (and are dropped) if the file
  changed since. Toasts offer Undo, and Redo after an undo.
- **Not undoable:** permanent deletion, removing snapshots, editing a capture's parts.

## Jobs

- **The Jobs view** lists:
  - "Running and waiting (n)", with Cancel and Cancel all
  - "Failed (n)", with "Why: …", Retry, Dismiss, Retry all and Dismiss all
  - "Recent", with repeats grouped ("Refreshing link labels · 12 times, last at …")
- **Jobs:**
  - text extraction
  - page saving
  - link-label refresh
  - index rebuild
- **Rules.** Jobs resume after a restart, and each checks for existing output before its final
  write.

## Palette, Open, shortcuts dialog

- **Command palette** (⇧⌘P): every available action, with its key. Quit, Undo/Redo and Tab 1–9
  are not listed.
- **Open** (⌘O): fuzzy titles over openable records, showing a note's folder or a record's kind.
- **Keyboard shortcuts** (⌘/): every action that has a key.
- **Keys in pickers.** These follow the APG combobox pattern: ↑/↓ move, Enter picks, Escape
  closes. They open in under 50 ms.

## Links to the web

- **The window never navigates away.**
- **The dialog.** Every http(s) or mailto link opens it: "Open this link in your browser?" or
  "Write this email?".
  - It shows the link's words, where it goes and the full address.
  - It warns when the words name another address, or when the link isn't https.
  - Buttons: Cancel, Copy link, Open in browser / Open in Mail.

## Settings (⌘,)

- **Appearance:** Theme (Follow the system / Light / Dark); Text size (14 / 16 / 18).
- **Library folder:** the path, Choose another folder…, Show in Finder.
- **Daily notes:** the hour the day starts.
- **Index:** Rebuild index.
- **Captures:** orphan files.
- **Version:** "Librarium x.y.z" and Check for Updates….
- **Troubleshooting:** Reveal logs.

Preferences are per device, in app data (`settings.json`), never in WebKit storage.

## Updates and releases

- **Checking.** The app checks 20 s after start, then daily.
  - Toast: "Librarium X is available." (**Update…**). The dialog shows What's new, with
    **Install** / **Later**.
  - Progress shows in the status bar.
  - Then: "Restart to use Librarium X?" (**Restart now**, which saves first, / **Later**).
- **Checking by hand** (Librarium ▸ Check for Updates…) also says "up to date" or "couldn't
  check".
- **Distribution.** Signed updates as GitHub releases (Tauri updater, same public key and
  endpoint). The first install is a `.dmg`. Apple silicon, macOS 15+, ad-hoc signed.
- **Releasing:** `npm run release -- <version> "<notes>"`.

## Menus

The menus are native. The menu bar, the palette and the shortcuts dialog come from one list of
actions. Items are enabled only when they apply.

- **Librarium:** About; Settings… ⌘,; Check for Updates…; Services; Hide / Hide Others / Show All;
  Quit ⌘Q.
- **File:**
  - New tab ⌘T, Reopen closed tab ⇧⌘T, New note ⌘N, New folder ⇧⌘N, New board ⌥⌘N
  - Open… ⌘O, Save web pages…, Add to library…
  - Move to folder…, Show in its folder
  - Show history ⌥⌘Y, Export with quotations…, Export board as PNG / SVG / Excalidraw file…
  - Archive, Restore from archive
  - Choose library folder…, Show library folder in Finder, Cancel all jobs, Rebuild index
  - Close tab ⌘W, Close window ⇧⌘W
- **Edit:**
  - Undo ⌘Z, Redo ⇧⌘Z
  - Cut, Copy, Paste, Select All
  - Undo / Redo the last move, rename or archiving
  - Capture the selection ⇧⌘C, Capture a region ⇧⌘R, Save the capture ⌘↩, Find in this item ⌘F
  - Link to a note or item… ⌥⌘K, Put a capture, note or item on the board… ⌥⌘I
- **Format:** Bold, Italic, Strikethrough, Highlight, Code, Link, Task, Heading 1–6, Body text.
- **View:** Command palette; Toggle sidebar; Toggle side panel; Theme (system / light / dark);
  Single Page / Two Pages / Scrolling (books); Board in Full Screen; Enter Full Screen.
- **Go:** Today, Notes, Library, Captures, Search, Archive; Back, Forward.
- **Window:** Minimize, Zoom; Next tab, Previous tab; Tab 1–8, Last tab.
- **Help:** Keyboard shortcuts, Reveal logs.

### App shortcuts

*Reserved* means the key wins over the editor and the board canvas. Key handlers ignore IME
composition.

| Keys | Action | Reserved |
|---|---|---|
| ⇧⌘P | Command palette | ✓ |
| ⌘O | Open | ✓ |
| ⌘/ | Keyboard shortcuts | ✓ |
| ⌘, | Settings | ✓ |
| ⌘\ | Toggle sidebar | ✓ |
| ⌥⌘\ | Toggle side panel | ✓ |
| ⌘T | New tab | ✓ |
| ⇧⌘T | Reopen closed tab | ✓ |
| ⌘W | Close tab | ✓ |
| ⇧⌘W | Close window (quits) | ✓ |
| ⌘Q | Quit | ✓ |
| ⌃Tab or ⇧⌘] | Next tab | ✓ |
| ⌃⇧Tab or ⇧⌘[ | Previous tab | ✓ |
| ⌘1–8, ⌘9 | Tab 1–8, last tab | ✓ |
| ⌥⌘← / ⌥⌘→ | Back / Forward | ✓ |
| ⌘Z / ⇧⌘Z | Undo / Redo | ✓ |
| ⇧⌘D | Today | ✓ |
| ⇧⌘K | Captures | ✓ |
| ⇧⌘F | Search | ✓ |
| ⌘N | New note | ✓ |
| ⌥⌘N | New board | ✓ |
| ⌥⌘K | Board: link the selection | ✓ |
| ⌥⌘I | Board: put something on it | ✓ |
| ⇧⌘↩ | Board: full screen | ✓ |
| ⇧⌘N | New folder | |
| ⌥⌘Y | Show history | |
| ⌘F | Find in this item | |
| ⇧⌘C / ⇧⌘R | Capture the selection / a region | |
| ⌘↩ | Save the capture | |
| ⌃⌘1 / 2 / 3 | Book layout | |

The formatting keys are listed under Notes and the editor.

## Look

The look is quiet and content-first, after Obsidian's defaults: the system font, true neutral
greys, one violet accent used sparingly, and small monochrome line icons (Lucide, stroke width
1.75, 18 px by default). Light and dark themes follow the system unless chosen (`data-theme` on
`<html>`). Text meets WCAG 2.2 AA in both.

### Tokens

| Token | Light | Dark |
|---|---|---|
| `--bg` | #ffffff | #1e1e1e |
| `--bg-alt` | #fafafa | #242424 |
| `--bg-sidebar` | #f6f6f6 | #262626 |
| `--border` / `--border-strong` | #e4e4e4 / #dadada | #333333 / #3f3f3f |
| `--ink` | #222222 | #dadada |
| `--muted` | #5c5c5c | #b3b3b3 |
| `--faint` | #6e6e6e | #949494 |
| `--accent` | hsl(258 88% 66%) | same |
| `--accent-text` | #6d3ff0 | #a68bfa |
| `--accent-solid` | #6d3ff0 | same |
| `--hover` / `--active` | rgb(0 0 0 / 6.7%) / 9% | rgb(255 255 255 / 7%) / 11% |
| `--selection` | accent at 22% | accent at 33% |
| destructive | #b42318 | #ff8a80 |

- **Type.**
  - The UI uses `-apple-system, BlinkMacSystemFont, system-ui, sans-serif`; code uses
    `"SF Mono", Menlo, monospace`.
  - The UI is 15 px / 1.3, with small sizes of 13 and 12 px.
  - Reading text is 16 px / 1.5 (14 or 18 by setting).
  - Page titles are 1.618 × the reading size, weight 700, letter spacing −0.015em, line height
    1.2.
- **Space and shape.**
  - A 4 px grid. Radii 4, 8 and 12 px.
  - Sizes: ribbon 44, sidebar 260, panel 320, header 40, status bar 24, page column 700.
- **Shadows** appear only on floating things:
  - dialogs: `0 2px 6px rgb(0 0 0 / 8%), 0 16px 48px rgb(0 0 0 / 16%)`
  - menus: `0 8px 24px rgb(0 0 0 / 22%)`
  - popovers: `0 12px 36px rgb(0 0 0 / 22%)`
- **Focus.** `outline: 2px solid var(--accent); outline-offset: -2px`. Inputs get an accent border
  and a 2 px `--selection` ring.
- **Motion.** Small and quick (toasts 0.15 s), and all of it is off under Reduce Motion.

### Components

- **Buttons.**
  - **Icon button:** 28 × 28 (24 when small), transparent until hovered, `--muted`; disabled at
    35% opacity.
  - **Button:** 28 px high, 4 px radius, a `--border-strong` border, 13 px text.
  - **Primary button:** `--accent-solid` with white text.
- **Input.** 28 px high, a `--border-strong` border, 4 px radius, `--bg` background.
- **Dialog.** A `<dialog>`, 12 px radius, at most min(560 px, 90vw) (880 when wide), over a 25%
  backdrop.
- **Palette and Open.**
  - 12vh from the top.
  - A 44 px borderless input.
  - Options 6 × 10 px, the chosen one on `--active`.
  - `kbd` hints at 12 px with a border.
- **Toast.** Inverted (`--ink` background), 8 px radius, bottom centre above the status bar.
- **Context menu.** At least 180 px wide, 8 px radius; the hovered item is accent with white
  text.
- **Empty state.** One calm sentence in a dashed `--border-strong` box with an 8 px radius.
- **Sidebar tree.**
  - Rows are 26 px, 13 px text.
  - Section rows are uppercase, 12 px, weight 600, muted.
  - Hover `--hover`, current `--active`, selected `--selection`.
  - It follows the APG tree pattern: one tab stop.
- **Tab bar.** 34 px high, on `--bg-alt`. Tabs are up to 200 px wide (at least 72), with
  8 px 8 px 0 0 radii. The active tab is on `--bg`, with a border.
- **Folder list.** Columns `1fr 150px 110px`, 28 px zebra rows. Focused selection is solid accent
  with white text, and folder icons are accent.
- **Side panel.** On `--bg-alt`, 13 px text. Section titles are 12 px uppercase, weight 600,
  muted.

### Notes

- **Title.** The page-title style, with no border.
- **Headings.** h1 1.6em/700; h2 1.35em/700; h3 1.15em/650; the rest weight 650.
- **Marks.**
  - Highlight on `--selection`.
  - Inline code in mono 0.9em on `--bg-alt`, with a border and a 3 px radius.
  - Quotes with a 3 px `--border-strong` left rule and muted text.
  - Visible Markdown marks in `--faint`.
- **Links.** `[[links]]` are `--accent-text`, underlined in `--selection`. Unresolved ones are muted
  with a dashed underline.
- **Code colours:**

  | Token | Light | Dark |
  |---|---|---|
  | keyword | #a855f7 | #c4b5fd |
  | string | #16a34a | #86efac |
  | number | #d97706 | same |
  | definition | #2563eb | #93c5fd |
  | type | #0891b2 | same |
  | comment | faint italic | same |

- **Capture embed.**
  - A figure on `--bg-alt` with a border, an 8 px radius and 8 × 12 padding.
  - The quote has a 3 px `--accent` left rule.
  - The caption is 13 px muted "— Source, place", with a pencil appearing on hover.
- **History diff.** Mono 13 px. Deletions on `rgb(220 38 38 / 12%)`, insertions on
  `rgb(22 163 74 / 12%)`.

### Reader

- **The stage.** On `--bg-alt`. PDF pages have `0 1px 3px rgb(0 0 0 / 12%)` and a 12 px margin.
- **Marks.**

  | Mark | Style |
  |---|---|
  | find hits | `rgb(255 200 0 / 38%)` |
  | the current hit | `rgb(255 130 0 / 50%)`, with a `rgb(214 96 0 / 90%)` ring |
  | saved captures | `rgb(255 196 0 / 20%)` with `inset 0 -2px 0 rgb(230 160 0 / 55%)` |
  | saved regions | a dashed `rgb(230 160 0 / 70%)` border |
  | pending | `rgb(255 196 0 / 35%)`, multiplied |
  | Show | 50%, fading over 2.5 s |

- **Selection pop-up.** Inverted, with an 8 px radius.
- **Capture edit bar.** A pill 44 px from the bottom.
- **Book themes:**

  | Theme | Background | Text | Links |
  |---|---|---|---|
  | White | #ffffff | #121212 | #2a5db0 |
  | Sepia | #f8f1e3 | #4f321c | #8a4f16 |
  | Gray | #4a4a4d | #e3e3e3 | #a8c7fa |
  | Night | #1c1c1e | #cfcfcf | #8ab4f8 |

  The defaults are matching the app, two pages, the book's spacing, medium width, not justified.
- **Footnote popover.** 380 px, Georgia / Iowan 15 px / 1.45.

### Icons and mark

- **The app icon** is generated from `assets/brand/app-icon-macos.svg` (Evergreen & gold:
  `#173F36` and `#DFC79F`) with `npx tauri icon`. The kit is in
  `assets/brand/librarium-icon-kit/`.
- **The interface mark** is the open book with a house, inlined in `currentColor`. It is shown at
  72 px in `--accent-text` on the Welcome page.
- **Kind icons:**
  - note: FileText
  - capture: Quote
  - board: Shapes
  - pdf: FileText
  - epub: BookOpen
  - image: Image
  - web: Globe
- **Ribbon icons:**
  - Today: CalendarDays
  - Notes: Files
  - Library: Library
  - Captures: Quote
  - Search: Search
  - Archive: Archive

## Accessibility

- **Dialogs and pickers.** The palette and Open follow the APG combobox-with-listbox pattern
  inside a modal `<dialog>`. Every dialog traps focus and returns it.
- **Status messages.** Toasts and the status bar use `role="status"`.
- **The keyboard.** Everything works from it, and VoiceOver reads every control.
- **Motion.** Animations respect Reduce Motion.

## Performance budgets

| Measure | Budget |
|---|---|
| Cold start to usable, with 10,000 notes | under 1.5 s |
| Keystroke to paint | under 16 ms |
| Palette opens | under 50 ms |
| Search, on 10,000 notes | under 150 ms |
| First page of a 100-page PDF | under 500 ms |
