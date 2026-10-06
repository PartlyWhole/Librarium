# Requests

Feature and change requests for Librarium: **you write, the AI answers here.**

## How it works

1. **You** add a request under **Inbox** in your own words. A line is enough; an example,
   a screenshot path or "why" helps. Copy the template below if you like.
2. **The AI** (at the start of each session, or when asked) takes each Inbox item:
   - gives it a number (`R-NNN`) and moves it to **In progress**;
   - asks you under **Waiting for you** when only you can decide (it never guesses at those);
   - when done, moves it to **Done** (newest first) with the answer: what changed, how to use
     it, where it is in the code, the commits and decision records, what was tested, and what
     is left.
3. **You** check Done. If something isn't right, write a new Inbox item that refers to the
   number (`About R-012: …`).

Your words are kept as you wrote them (quoted under each answer). Deeper design notes live
in `docs/decisions/`; how the code is organised, in `docs/DEVELOPING.md`.

### Template

```
### (short title)
What I want:
Why / example:
How urgent (optional):
```

---

## Inbox

<!-- Write new requests here, newest at the bottom. -->

### R-028 · (found by the AI) Find misses words with "ff"/"fi" in saved pages
While fixing R-027: in web pages saved as PDFs, PDF.js reads some ligatures wrongly
("different" as "diSerent", "fiction" as "Pction"), so find in the reader misses them. Search
across the library uses PDFKit's text and isn't affected. To look into: the stored text
(PDFKit) has the right words and could correct the reader's text.


---

## Waiting for you

(Nothing waiting.)

---

## In progress

### R-066 · EPUB views: two pages, one page and scrolling are hard to switch between
> "the views of the epub aren't very UX friendly -- switching between two page vs one page vs
> continuous, there are a lot of options and switching between them isn't easy. Please
> diagnose the state of it before we fix it"

- **Diagnosis (2026-10-06):** checked in the preview and in WebKit.
  1. **Two controls, far apart, for one choice.** "Scrolling view" is a checkbox below the list
     of nine fonts. "Pages: Two when wide / One" is hidden under Customise, and at a normal
     window height you must also scroll inside the panel to reach it.
  2. **The panel jumps.** "Pages" disappears while scrolling is on, so the controls move under
     your pointer.
  3. **"Two when wide" is invisible.** Whether you get two pages depends on the window, the
     text size and the line length. At 720 px it showed one page with nothing saying why.
     Resizing the window or opening the side panel flips it silently.
  4. **Scrolling view has no side margins.** The text sits against the left edge, unlike
     pages, where it's a centred column.
  5. **Switching loses your place.** Pages → scrolling kept it (paragraph 60), but scrolling →
     pages moved about a page on (paragraph 67).
  6. **Only through the Aa panel,** behind the toolbar that appears on hover: no menu item, no
     shortcut, no palette command.
- **Decision (2026-10-06, after looking at Apple Books):** "Like Books, plus visible".
  - The Aa panel's top row: text size, then **Layout: Single page | Two pages | Scroll**.
  - The View menu has Single Page, Two Pages and Scrolling, with shortcuts.
  - Two pages falls back to one when the window is narrow, and says so.
  - Switching keeps your place; scrolling gets margins; the font list shrinks to one row.
- **Next:** build it.

---

## Done

### R-065 · Footnotes in EPUBs don't work
> "the footnotes of EPUBs don't work" · "fix the EPUB footnotes"

- **Diagnosis:** clicked as a hand clicks (real clicks from the test runner, the pointer moving
  a few pixels), three things went wrong:
  - **Readium drops a click that moved more than one pixel,** and stops the browser following
    the link. So a footnote often did nothing, depending on how still your hand was.
  - **Footnote numbers are tiny** (`2` is about 5 pixels wide). Let go just off it, and the
    click belongs to the paragraph, not the link.
  - **Notes files marked `linear="no"`** (common) were left out of the reader, so links into
    them went nowhere.
  - Clicks made by a test script hid all three: Readium accepts those regardless of movement.
    Your books follow both common layouts. *Dialectical Theology and Jacques Ellul* has notes
    at the end of each chapter; *Either/Or* has a separate notes file. In real clicks, both
    failed in the same way.
- **Changed:**
  - The reader now follows links in the book itself. A link is followed when you let go within
    a few pixels of it. A drag that selects text still selects; it doesn't jump.
  - Notes files marked non-linear are part of the book.
  - Links to the web still ask before opening.
  - **A footnote opens in a popover** beside its number (you chose this, as Apple Books does),
    with **Go to note** and **Close**. Notes at the end of a chapter, in a separate notes file,
    and marked with an empty anchor all work.
  - Links that aren't notes (and very long notes) still go to their place.
- **Use:** click a footnote number to read the note over the page. **Go to note** goes there
  (its back-link, ↵, returns you); Escape or a click elsewhere closes it.
- **Code:** `src/reader/epub/engine.ts` (`follow`, the frame's link handling),
  `src/reader/epub/streamer.ts` (reading order), `scripts/webkit-run.swift` (`nativeClick`:
  real clicks for checks).
- **Decisions:** 0068 (links), 0069 (popovers).
- **Tested:** 7 WebKit checks with real moving clicks on a test book shaped like yours:
  - a note at the end of the chapter, in a popover, the page staying put;
  - Go to note, and back;
  - a note in a separate notes file, closed with Escape;
  - a note marked with an empty anchor, in a non-linear file with a space in its name;
  - a link that isn't a note going to its place, and back;
  - a drag from a note number selecting text rather than jumping.

  All but the drag failed before the fix. The streamer test now expects non-linear items in
  the book (a deliberate change). All 242 interface tests, 82 WebKit checks and the Rust tests
  pass (one Rust library test timed out once and passed on reruns; unrelated); lint is clean.
  Your two books were checked from temporary copies, deleted afterwards.
- **Left:** nothing. Books whose note links are words ("see note 3") go to the note rather
  than open a popover.

### R-057 · Boards: a note you can draw on (Excalidraw), with captures and links
> "Please plan an excalidraw page "feature" that supports putting in captures and [[]] links,
> etc. Basically a note but can draw/write on it like a whiteboard. This is going to be a big
> feature because there are a lot of tools already with excalidraw. Please plan carefully"

- **Plan:** `docs/plans/boards.md`: what it is, how saving, links, captures and keys work,
  seven phases with acceptance checks, risks, and what's left out.
- **Decided:** React for boards only (D1, decision 0061); boards beside notes (D2).
- **Phase 0 (the test run) passed** in WebKit with the app's security policy:
  - first open 219 ms in a production build;
  - nothing goes to the network;
  - a capture card of our own shows on the board;
  - ⌘Z undoes one step;
  - the dark theme applies;
  - drawings save and reload;
  - SVG pictures work;
  - `[[` typed on the board can be seen.
  - Results are in `docs/plans/boards.md` §8.
- **Done with it:**
  - React, ReactDOM and Excalidraw added, pinned, and allowed only in boards (a code rule,
    tested).
  - Fonts served locally, and Excalidraw's CDN fallback pointed at them.
  - Nested packages patched (`npm audit`: 0).
- **Decided:** the two-file format (D3, decision 0062).
- **Phase 1 (the kind and its storage) done:**
  - **What a board is:** a `board` kind kept in the Notes folders. On disk it's
    `<id>-title.md` (a readable page) plus `<id>.excalidraw` (the drawing).
  - **Calls:** `boards.create`, `boards.load` and `boards.save`. A save writes both files,
    and is refused if either changed since the board was opened.
  - **Kernel changes:** kinds stored alike may share a folder. Folder lists, moves and
    removal cover them all. A record moved to another folder now takes its side files.
  - **Tests:** Rust tests for each, including a save interrupted at every step.
  - **Code:** `crates/features/boards`, `crates/kernel/src/{kinds,folders,store}.rs`,
    `crates/contracts` (`BoardLoaded`, `BoardSaved`, `FolderSpace.kinds`).
  - **Changed on purpose:** the API test now expects `kinds` in the folder list.
- **Phase 2 (the board page) done** (decision 0063):
  - **New board:** File ▸ New board, ⌥⌘N. It's made beside the note or folder you're in,
    opens with its title ready to type, and is listed with notes (its own icon) in the sidebar
    and the Notes page. Rename… and Move to folder… work as for notes.
  - **Drawing:** Excalidraw's tools, in the app's light or dark look. It saves a second after
    you stop, with its readable page (the board's texts). A drawing not yet saved when the app
    stopped comes back, with "Discard it".
  - **Changed elsewhere:** with nothing unsaved, the board shows the new version. With
    unsaved changes, the other version is kept as a copy, "… (version from elsewhere)", and
    yours is saved.
  - **⌘Z / ⇧⌘Z:** undoes drawing steps, and steps done on the board's page (like renaming),
    in order. Leaving the board forgets its drawing steps.
  - **Pictures:** not yet (phase 4); pasting one says so.
  - **Fixed on the way:** ⌘Z sent to the canvas was caught by the app's own shortcut again,
    so one press ran through every step.
  - **Tested:** 9 interface tests and 4 WebKit checks with the real Excalidraw. In the preview:
    make, name, draw, leave and come back, and ⌘Z / ⇧⌘Z through shapes and the rename.
  - **Only the real app can show:** ⌘Z from the macOS menu bar reaching the canvas.
- **Phase 3 (links) done** (decision 0064):
  - **Typing `[[`** in a text on a board opens the title picker. Picking puts the record's
    name in the text and links it.
  - **Edit ▸ Link to a note or item… (⌥⌘K)** links whatever is selected. ⌘K on a board
    stays Excalidraw's own link to a web address.
  - **Clicking a link** opens the record (⌘-click: a new tab). Web links ask first.
  - **Backlinks:** a linked note lists the board under "Linked from". Boards show the Links
    view too. A renamed record's new name is written into the board's readable page at its
    next save.
  - **Fixed before it could happen:** renaming a linked note makes the background job refresh
    names in the board's page. That would have made a board with unsaved changes save a
    "version from elsewhere" copy. A page-only change is no longer a conflict.
  - **Kept React out of start-up:** a new code rule allows the drawing engine to be imported
    only on demand. It caught an import of mine that would have pulled React into the start-up
    bundle.
  - **Tested:** 6 more interface tests and 2 more WebKit checks with the real Excalidraw. In
    the preview: `[[` → picked a note → the text reads its name → clicking the link opened the
    note, whose Links view lists the board.
  - **Not ideal:** hovering a link shows its address (`librarium://record/…`), not the
    record's name. That's Excalidraw's own tooltip.
- **Phase 4 (captures, notes, items and pictures on boards) done** (decision 0065):
  - **Put on the board… (⌥⌘I, Edit menu)** puts a capture, note, item or board on the board
    shown. You can also drag things from the sidebar or a folder page, paste a picture, or drop
    files from Finder.
  - **A capture is a card** showing its quotation and citation, as in notes, with Show in the
    source. It's redrawn when the capture changes. Notes, items and boards are cards with
    their icon and name; a click opens them.
  - **Pictures** come from the library (pasted ones are kept in Attachments, as in notes). The
    drawing file keeps only their ID; they're loaded from the library when the board opens.
  - **The readable page** writes captures and pictures as `![[…]]`, so a capture lists the
    boards using it.
  - **Fixed on the way:** cards didn't show at all. Excalidraw's element builder doesn't make
    embed elements; they're now built the way its file reader builds them.
  - **Tested:** 6 more interface tests and 2 more WebKit checks with the real Excalidraw. In
    the preview: a capture put on a board showed its quotation and citation. A picture
    dragged from the sidebar landed where it was dropped, and came back after leaving the
    board.
  - **Only in the real app:** dropping files from Finder onto a board.
  - **Known:** a card is interactive (its buttons) after selecting it and clicking again; its
    link marker opens the record at once. Opened at excalidraw.com, a board shows its cards as
    empty frames and its pictures as missing (export with pictures comes in phase 5).
- **Phase 5 (boards elsewhere) done** (decision 0066):
  - **A board in a note:** type `![[` and pick a board, as for a capture. The note shows a
    picture of the board, captioned with its name; a click opens it. It's redrawn when the
    board is saved.
  - **Export:** File ▸ Export board as a picture (PNG)… / (SVG)… / as an Excalidraw file….
    The board is saved first, then written where you choose.
  - **Reads anywhere:** in pictures and in the Excalidraw file, each card is written out as a
    box with its words (a capture's quotation and citation; else the record's name and kind).
    The Excalidraw file carries its pictures inside, so it opens complete at excalidraw.com.
  - **Tested:** an API test for byte exports, 3 interface tests, and 2 WebKit checks with the
    real Excalidraw. In the preview: a board with a text and a capture card, shown in a note
    as its picture with the quotation written out.
  - **Only in the real app:** the save dialog.
- **Phase 6 (polish) done** (decision 0067):
  - **Keys:** Excalidraw's own shortcuts work on a board, except ⌘/, ⇧⌘P, ⌘O and ⇧⌘[ / ⇧⌘],
    which stay the app's (Excalidraw's ⌥⌘[ / ⌥⌘] still bring forward and send back). ⌘Z /
    ⇧⌘Z go to the board. A test fails if a new app shortcut takes another of Excalidraw's.
  - **VoiceOver:** the canvas is named ("Drawing: …"), and a list beside it reads what is on
    the board (texts, links, cards and pictures by name). Cards are named. The board page
    passes the axe check.
  - **Speed:** a board of 380 elements opens in 20 ms, saves in 1 ms and is drawn as a picture
    in 58 ms, checked in WebKit.
  - **The architecture report** covers every feature, and captures got their proper name and
    icon in pickers and on boards.
- **All six phases are done.** The plan, `docs/plans/boards.md`, is complete. Decisions
  0061–0067 record what was chosen.
- **Only the real app can show:**
  - ⌘Z from the macOS menu bar reaching the canvas;
  - files dropped from Finder onto a board;
  - the save dialog for exports.
- **Left:**
  - a link's tooltip on the canvas shows its address, not the record's name;
  - a card's buttons work after selecting it and clicking again;
  - Excalidraw forgets a board's drawing steps when the board is closed.

### R-064 · ⌘Z for the page you are on, each page keeping its history
> "I want cmd-z to handle whatever page the user is on. If it's on a note, it's whatever edits
> are being made to a note. If it's on a captures page, it's whatever is happening to a
> capture. If things (library items/notes) are being deleted or moved around in library/notes
> page then cmd-z should undo. When I move away from the page, it seems like the history is
> forgotten. I want each page to keep its own history, at least when the app is still
> running. … please think about best practices"
> Chosen (after a proposal): one history per note, stay on a capture's page after deleting it,
> one shared Library & notes history, kept while the app runs.

- **Changed:** ⌘Z / ⇧⌘Z act on the page shown. A note's typing, renaming it from its title,
  moving it from its header and restoring a version undo in the order done, and its history
  is still there after going elsewhere and coming back (unless the file changed outside
  meanwhile; then only the typing is forgotten). A capture's page: its words, renaming and
  deleting; deleting stays on the page ("in the archive", with Restore) and ⌘Z there restores
  it. The sidebar (focused, or last clicked, e.g. after one of its menus) and the Library,
  Files, Captures and Archive pages share one history for moving, renaming, archiving and
  folders. A search box or title being edited undoes its own text. Edit ▸ Undo names the step
  ("Undo Typing", "Undo rename to “…”"). Outside changes to an open note (an outside edit, a
  restored version, a capture's places rewritten) are no longer undone as typing; the step
  that made them undoes them.
- **Use:** ⌘Z / ⇧⌘Z, or Edit ▸ Undo / Redo. "Undo the last move, rename or archiving" in the
  Edit menu still reaches the latest app action wherever it was done.
- **Code:** `src/shell/undo.ts`, `src/shell/text-undo.ts`, `textHistory` / `historyJSON` /
  `onHistoryStep` / `replaceDoc` in `src/editor/editor.ts`, the note page
  (`src/features/notes/page.ts`, `history.ts`), the capture page and deleting
  (`src/features/captures/index.ts`, `delete.ts`), getters kept in `src/shell/actions.ts`.
- **Decision:** 0060 (amends 0055 and brief §6).
- **Tested:** Vitest: `tests/undo-scopes.test.ts` (typing and renaming in order, redo; kept
  after leaving and coming back; forgotten after an outside change; Library history away from
  a note and not inside one; the sidebar after one of its menus; a capture deleted and
  restored on its page) and `tests/undo.test.ts` (menu items now found by ID, as their words
  name the step; changed on purpose). Full suite 235 passing. Preview: typing undone after
  going to another note and back; archiving from the sidebar's menu undone with ⌘Z. Not
  checked in the real app (the native menu's names and ⌘Z through it).
- **Left:** editing a capture's selection isn't undoable yet; two tabs on one note share its
  history. Fixed in passing: "This is the place" on a moved capture part now redraws the page.

### R-063 · An archived capture shows as source, not as the capture
> "Archiving a capture should not render the capture (if the user fails to remove the source
> code/capture, then it just remains as source code…)"

- **Changed:** a placed capture whose capture is archived (or no longer in the library) shows
  as its source, `![[words]]` (the ID stays hidden), with a tooltip saying why. Restoring it
  (Undo, or from the archive) draws it again at once, in open notes too. The same holds for
  images placed in notes. The delete dialog's "Leave in place" says so.
- **Use:** nothing to do.
- **Code:** `embedShown` in `src/features/captures/embeds.ts`; `embedShown`,
  `refreshPreview` and `.cm-embed-unshown` in `src/editor/livepreview.ts`; `EditorContribution`
  in `src/editor/editor.ts`.
- **Decision:** 0059 amended (and 0047).
- **Tested:** Vitest (`tests/captures.test.ts`: archived shows the source with the ID hidden,
  restored draws it again; this replaces the "In the archive" check on purpose). Preview: a
  capture left in place in an indented quote, then Undo from the toast.
- **Left:** nothing.

### R-062 · No archiving several captures at once
> "Do not allow archiving several captures at once until it is a feature that is requested."

- **Changed:** the Archive action no longer applies to captures, so selecting several can't
  archive them; a capture is deleted only by its own Delete, one at a time, which asks about
  the notes using it.
- **Use:** Delete on a capture (page, panel, Library menu, Captures page, popover).
- **Code:** `src/features/archive/index.ts` (the archive action), `archiveCapture` in
  `src/features/captures/index.ts` (through `shell.archiver`, with its own Undo).
- **Decision:** 0059 (consequences).
- **Tested:** Vitest (`tests/captures.test.ts`: no Archive for one or several captures).
- **Left:** captures archived with a folder (0057) still skip the dialog.

### R-061 · Deleting a used capture: choose what happens to each place
> "When deleting a capture, I want the user to have to edit/confirm how to handle each
> reference being made to the capture. Make sure the UI/UX is good here"

- **Changed:** deleting a capture that notes use opens a dialog listing each place, grouped by
  note, with the line before it and the quotation (or the link's sentence). For each: Keep as
  quoted text (the default, nothing is lost), Remove, or Leave in place; each says what the
  place will become, and "For every place" sets them all. The button says how many notes
  change. Delete rewrites those notes and archives the capture; one Undo puts all of it back.
  A capture used nowhere is deleted as before.
- **Use:** Delete a capture anywhere (page header, Captures panel or page, Library menu, a
  highlight's popover). Choose per place, then "Delete and update N notes". Undo from the
  toast, or the palette's "Undo the last move, rename or archiving".
- **Code:** `src/features/captures/references.ts`, `src/features/captures/delete.ts`,
  `deleteCapture` in `src/features/captures/index.ts`, styles in `src/shell/shell.css`.
- **Decision:** 0059.
- **Tested:** Vitest: `tests/capture-references.test.ts` (11 tests: finding, keeping as text
  on its own line, indented, in a quote, in a list, in a sentence, a picture; removing; several
  at once) and `tests/captures.test.ts` (the dialog's defaults and descriptions, mixed
  choices, the button's count, the rewritten note, archiving, one Undo, Cancel). Preview: a
  capture used in two notes (one in an indented quote) plus a link; Remove, Leave and Keep
  the words; the notes after; Undo restoring both; Escape cancelling. Not checked in the
  real app.
- **Left:** archiving several captures at once (multi-select's Archive) or with a folder
  skips the dialog; deleting for good from the archive doesn't ask again. ⌘Z after deleting
  undoes the last open note's typing first (Librarium's Undo goes to the last editor used);
  the toast's Undo and the palette reach the delete.

### R-060 · Open a capture from a note; show where it is used
> "Clicking on captures (not the source), I want to open up to the capture page. The capture
> page should also show me what notes reference the capture."

- **Changed:** a click on a capture placed in a note opens the capture (⌘-click: a new tab);
  the card reacts to hover; the citation still opens the source. The capture page lists
  "Used in": each note, and under it each place (the line before it, or the link's
  sentence); a click goes there. The side panel's Links view also works on capture pages.
- **Use:** click the quotation in a note; on the capture page, scroll to "Used in".
- **Code:** the embed renderer in `src/features/captures/index.ts`, `embeds.ts`;
  `findReferences` in `references.ts`; `.used-in` styles.
- **Decision:** 0059.
- **Tested:** Vitest (`tests/captures.test.ts`: a click opens the capture, the citation the
  source; Used in lists notes and places, and a place opens the note there). Preview: both.
  Not checked in the real app.

### R-059 · Indent captures and links
> "Please support tab/indent support for captures and internal links. Sometimes tabbing
> links/captures will turn the text into this kind of font and just doesn't render even if I
> click away. And even if it renders, and I indent the source "code" for my capture, the
> indent doesn't affect the capture displayed. I want to be able to indent my captures"
> Chosen: "Option 1, indent is indent."

- **Changed:** an indented line is no longer code (Markdown's old rule), so indented links
  and captures keep working, in the editor and for backlinks. Indenting moves text, quotes
  and captures right; wrapped lines stay under the first. Code is what's fenced with ```.
- **Use:** Tab indents a line (a tab), ⇧Tab outdents, Enter keeps the indent. On list items
  Tab still nests the item.
- **Code:** `src/editor/indent.ts`, `NoIndentedCode` in `src/editor/links.ts`,
  `src/editor/markdown.ts`, `indentUnit` in `src/editor/editor.ts`, `code_ranges` in
  `crates/kernel/src/links.rs`, shared cases in `tests/fixtures/links.json`.
- **Decision:** 0058; brief §5.4 amended.
- **Tested:** Vitest (`tests/editor-indent.test.ts`: columns, Tab, margin and shown link,
  raw tabs while editing, fenced code untouched); the shared fixture case "indented code is
  not a link" is replaced on purpose by "indented lines are not code", plus an indented
  quote with an embed and inline code on an indented line (Rust and TypeScript). Preview: a
  capture at no indent, one tab and two tabs inside a quote; an indented wrapped paragraph
  with a link; Tab, ⇧Tab, Enter. Not checked in the real app.
- **Left:** in Obsidian or on GitHub indented lines still show as code (accepted). Clicking a
  capture box doesn't move the cursor to its line, as before; use the arrow keys to edit
  its source.

### R-058 · Links that behave as in Obsidian
> "I am unable to click on the link I just made" (screenshot: `[[Questions]]`, cursor at its end)
> "I want it to behave like Obsidian: if I hover over, it reacts to that; if i move my typing
> cursor to it, it shows [[...]]; otherwise it renders as a link. Even if it shows [[...]], I
> can still click on the link with cmd+click, so I can still edit it normally if I don't use
> cmd" · "If it's not showing source mode, then clicking on it without cmd should navigate
> via link"

- **Changed:** a link reads as a link unless the cursor is in it or right beside it (as just
  after typing it), when it shows `[[…]]` for editing. A shown link reacts to hover (light
  background, solid underline, pointer) and opens on a click. While `[[…]]` shows, a plain
  click edits it and ⌘-click opens it; holding ⌘ makes it react to hover as a link. A link
  with no note yet makes the note either way. (First fix, `0648fa8`, opened `[[…]]` on a plain
  click; replaced at the user's request.) Fixed too: a plain click on a shown link did
  nothing in a real browser, because the mousedown moved the cursor beside the link, which
  showed its source before the click arrived; the cursor now stays put.
- **Use:** click a link to open it; move the cursor into it to edit; ⌘-click while editing to
  open. ⌘-click a shown link opens it in a new tab, as before.
- **Code:** `src/editor/editor.ts` (`mousedown` for ⌘-click on `.cm-wikilink-source`,
  `follow`, the `mod-held` class), `src/shell/shell.css` (hover styles).
- **Commits:** `0648fa8`, and the one recording this · **Decision:** 0037 amended.
- **Tested:** Vitest (`tests/notes.test.ts`: a shown link's mousedown leaves it shown and the
  click opens it, failing without the fix; plain click on `[[…]]` doesn't open, ⌘-click
  does; `tests/writing.test.ts`: ⌘-click on an unresolved `[[…]]` makes the note); full suite
  passing. Preview: typed and accepted a link; plain click placed the cursor; away from the
  cursor it rendered, reacted to hover and opened on a plain click; ⌘-click on `[[…]]` opened the note. Not checked in
  the real app.
- **Left:** hover previews of the linked note (Obsidian's ⌘-hover popup) are still not built.

### R-056 · The source cited twice; Edit as the pencil icon
> "why is the source repeated twice when theres two disjoint captures? It should always be the
> same source. And the "Edit" button should be the same edit icon"

- **Diagnosis:** the source wasn't repeated per part. A citation is "Source, where", and in an
  EPUB the "where" is the chapter's name from the book's contents. In *Fear and Trembling and
  the Sickness Unto Death*, the chapter is named exactly like the book, so it read "Title,
  Title".
- **Changed:**
  - A place that only repeats the book's title is left out, so the citation reads
    "— Fear and Trembling and the Sickness Unto Death". This applies to embeds, the capture
    page, exports and the new-capture form, and to captures already made.
  - An embed's Edit is now the pencil icon used elsewhere for editing. It shows on hover and
    is named "Edit the capture" for VoiceOver.
- **Code:** `src/features/captures/index.ts` (`cite`, the embed's edit button),
  `src/shell/shell.css` (`.embed-edit`).
- **Tested:**
  - A new interface test: a capture whose place matches the book's title is cited once, a
    real chapter is kept ("Title, Chapter 2"), and Edit is an icon with its name.
  - In the preview: an embed in a note, with the pencil on hover.
  - All 185 interface tests, 64 WebKit checks and the Rust tests pass; lint is clean.
- **Left:** a capture whose parts are on different pages still cites the first part's page
  only.

### R-055 · Captures of several parts should read as one quotation
> "Disjoint captures should have [...] continuous. See photo attached, it is a new line with
> the vertical purple line cut off as well"

- **Changed:** a capture of several passages now reads as one quotation, with one unbroken bar,
  and "[…]" inline where a passage is left out ("…revelatur […] doubt; for Descartes…"),
  as a quotation is written. Before, each part started a new block on a new line. This
  applies everywhere a capture is shown:
  - embedded in a note;
  - on the capture page, where each part's Show button and any "moved" or "lost" status
    sit right after its text;
  - in the new-capture form in the side panel, where each part's × to remove it sits after
    its text.
  - A captured picture between passages still stands on its own.
- **Use:** nothing new.
- **Code:** `src/features/captures/index.ts` (`quoteParts`), `src/shell/shell.css`
  (`.quote-gap`, inline tools).
- **Tested:**
  - Interface tests: the form shows one quotation with the parts joined by "[…]", and
    removing a part still works. A new test checks that a two-part capture embedded in a note
    is one quotation. The several-parts test was updated on purpose (it counted one block per
    part).
  - In the preview: the form and the capture page.
  - All 184 interface tests, 64 WebKit checks and the Rust tests pass; lint is clean.
- **Left:** nothing.

### R-054 · Delete folders, archiving what's inside after asking
> "Allow deleting folders (when items are in the folders, confirm archiving items inside)"

- **Changed:**
  - A folder's right-click menu (in the sidebar and on the Notes and Library pages) has
    **Delete folder**.
  - An empty folder is deleted at once.
  - A folder with things in it asks first: "The N items inside go to the Archive, where you can
    restore them (they come back in this folder) or delete them for good." Choosing
    **Archive N items and delete** archives everything in it and its subfolders, removes the
    empty folders inside, and the folder disappears.
  - ⌘Z (or the toast's Undo) brings it all back; ⇧⌘Z deletes it again.
- **Use:** right-click a folder ▸ Delete folder… ▸ Archive N items and delete.
- **Good to know:**
  - Nothing is removed from disk: archived items keep their place, so the folder stays in
    Finder with them, and the app hides it.
  - Restoring any of them brings the folder back.
  - After you delete them permanently from the Archive, the empty folder shows again and can
    be deleted at once.
- **Code:** `src/shell/folders/ops.ts` (`deleteFolder`), `src/shell/folders/index.ts`,
  `src/features/archive/index.ts` (lends archiving through `shell.archiver`),
  `src/shell/slots.ts`.
- **Decision:** 0057.
- **Tested:**
  - Interface tests: an empty folder deleted at once; a folder with two notes and an empty
    subfolder asks, archives both, removes the subfolder and disappears; Undo restores
    everything, Redo deletes again; Cancel changes nothing.
  - All 183 interface tests, 64 WebKit checks and the Rust tests pass; lint is clean.
- **Left:** nothing.

### R-053 · Capturing split the screen; details belong in the right side bar
> "Also, I still have this split screen when capturing. Epub should remain full main view,
> while capture details should be on right side bar"

- **Changed:** the capture you're making (its parts, your words, Discard / Save) now shows at
  the top of the side panel's **Captures** view, above the captures already made from the
  book. Capturing opens the side panel there. The book or document keeps the whole main
  view. After Save or Discard, the list stays, with the new capture in it.
- **Use:** select and capture as before (⇧⌘C, or the highlighter button); ⌘↩ saves.
- **Code:** `src/features/captures/index.ts` (`draftShown`, the Captures view's
  `capture-draft-host`).
- **Decision:** 0056.
- **Tested:**
  - Interface tests: every capture test now finds the panel in the Captures view and checks
    the reader's aside stays empty. A new test on the item page checks that the real side
    panel opens with the panel in it, and that Discard removes it.
  - In the preview, on a PDF: the reader kept the page, the panel appeared in the side panel,
    and Save added the capture to the list.
  - EPUBs use the same code; only the real app shows it on your books.
- **Left:** nothing.

### R-052 · Rename library items, make folders and open pages from the sidebar
> "Can I rename library items, add folders (by right clicking on Library, Notes or folders in
> them?) on left sidebar? I want to also go to Notes page or Library page by an option via
> right click on side bar."

- **Changed:**
  - **Rename…** is in the right-click menu of every library item and note: in the sidebar, on
    the Library and Notes pages' lists, in tabs and elsewhere. It asks for the new title; the
    file name follows, and ⌘Z undoes it. It isn't offered for several items at once or for
    archived ones. The Files page keeps renaming in place.
  - **The Notes and Library headings** have a menu: Open Notes / Open Library, Open in new
    tab, New folder….
  - **The sidebar's empty space** has a menu: Go to Notes, Go to Library, New folder in
    Notes…, New folder in Library….
  - Folders already had New folder inside…, Rename…, Move to… and Remove folder.
- **Use:** right-click in the sidebar.
- **Code:** `src/shell/folders/index.ts` (rename action, `topMenu`, `newFolderIn`),
  `src/shell/shell.ts` (heading and empty-space menus; record actions can be `single`),
  `src/shell/slots.ts`, `src/features/notes/index.ts`, `src/features/library/index.ts`.
- **Tested:**
  - New interface tests cover renaming from a sidebar row (with Undo), Rename only for one
    record, the heading menus (open, new folder) and the empty-space menu (go to, new folder).
  - Menu tests that list the exact entries were updated on purpose to include Rename….
  - Checked in the preview. All 181 interface tests, 64 WebKit checks and the Rust tests pass;
    lint is clean.
- **Left:** nothing.

### R-051 · Remove Undo history; undo and redo moves and archiving
> "Remove undo history, but also allow undo/redo for moving folders/files around in notes and
> library as well as archiving"

- **Changed:**
  - The Undo history view is gone from the side panel.
  - Moves, renames and archiving can be undone and redone several steps back (up to 50 in a
    session), newest first. A new action clears what could be redone. This covers:
    - moving notes, items and folders (dragging, the menu, the Files page) and arranging by
      hand;
    - renaming folders, notes, captures and items;
    - removing an empty folder;
    - archiving and restoring;
    - Move to the Library;
    - restoring an earlier version.
  - As before, a step refuses if the file changed since, and then it's dropped.
  - This answers R-049's question with option A: ⌘Z / ⇧⌘Z undo and redo these whenever the
    focus isn't in text. In a note, ⌘Z is still the note's text; in a text field, the field's.
  - Toasts offer Undo after an action, and Redo after an undo.
- **Use:**
  - ⌘Z / ⇧⌘Z after a move or archiving, for example in the sidebar or the Files page.
  - From inside a note, use Edit ▸ Undo (or Redo) the last move, rename or archiving.
  - All of them are greyed out when there's nothing to do.
- **Code:** `src/shell/undo.ts`, `src/shell/text-undo.ts`, `src/shell/shell.ts`; steps in
  `src/shell/folders/ops.ts`, `src/shell/folders/index.ts`, `src/features/archive/index.ts`,
  `src/features/library/index.ts`, `src/features/notes/page.ts`, `src/features/notes/history.ts`,
  `src/features/captures/index.ts`. The view (`src/features/undo-history/`) was removed.
- **Decision:** 0055 (0053 superseded).
- **Tested:**
  - Interface tests: two archivings undone and one redone, with a new action clearing redo; a
    dragged move undone, redone and undone again. The Edit items undo and redo app actions
    away from text, leave them alone inside a note, and grey out with nothing to do.
  - In the preview: a note dragged into a folder, then ⌘Z moved it back and ⇧⌘Z moved it in
    again.
  - The Undo history tests were removed with the view; the Edit ▸ Undo tests moved to
    `tests/undo.test.ts`. All 176 interface tests, 64 WebKit checks and the Rust tests pass;
    lint is clean.
  - The native menu path for ⌘Z can only be confirmed in the real app.
- **Left:** permanent deletion still can't be undone (by design).

### R-050 · Grey out Undo when there's nothing to undo
> "if theres nothing to undo, please ghost/block command"

- **Changed:**
  - Edit ▸ Undo and Redo were macOS's built-in items, which the app couldn't grey out. They are
    now the app's own and follow what has focus.
  - **In a note:** on only when there is a step to undo or redo.
  - **In a text field:** on while you're in it (a field doesn't say how much it can undo).
  - **Anywhere else:** greyed out, and ⌘Z does nothing.
  - Undo the last rename or move was already greyed out with nothing to undo, and still is.
- **Use:** ⌘Z / ⇧⌘Z as before, or the Edit menu.
- **Code:** `src/shell/text-undo.ts`, `src/shell/shell.ts`, `src/shell/menu.ts`.
- **Decision:** 0054.
- **Tested:**
  - Interface tests: the Edit menu starts with Undo and Redo, with their keys, greyed out.
    In a note they come on after typing, undo and redo the text, and grey out again. Away
    from text they're off; in a field they're on.
  - The menu test was updated on purpose (Undo and Redo are no longer built-in items).
  - All 175 interface tests, 64 WebKit checks and the Rust tests pass; lint is clean.
  - The greyed-out native menu and ⌘Z going through it can only be seen in the real app.
- **Left:** the R-049 question (should ⌘Z undo renames and moves when you're not typing?) is
  still under Waiting for you. If yes, it plugs into these same items.

### R-049 · Show what ⌘Z works on (temporary, a side panel tab)
> "Can you show the history of what cmd-z works on? I want this only to be temporary, but maybe
> a side panel tab"

- **Changed:** a new **Undo history** view in the side panel, on every page. It has two parts:
  - **This note's text:** on a note, the steps ⌘Z would undo, newest first ("Typed “…”",
    "Deleted “…”", "Replaced “…” with “…”"), with the next one marked. Below them is what ⇧⌘Z
    would redo. The list comes from the editor's own undo history, so it matches the keys
    exactly, and it updates as you type and undo.
  - **Renames, moves, archiving:** what you did this session, with the time and whether it can
    still be undone. Only the latest can be, and it has an Undo button.
- **Use:** open the side panel (the button at the right of the header) and choose the ↶ tab.
- **Temporary:** nothing is saved, so the log ends when the app quits. The view is
  self-contained, so it can be removed later in one step: delete
  `src/features/undo-history/` and its line in `src/main.ts`.
- **Code:** `src/features/undo-history/index.ts`; `src/shell/undo.ts` (`log`);
  `src/editor/editor.ts` (`textHistory`, `editorOn`, `editorChanged`); `src/shell/shell.css`.
- **Decision:** 0053.
- **Tested:**
  - Interface tests: text steps before and after an undo, including redo, and app actions
    (latest, replaced, undone).
  - In the preview: typing, deleting and ⌘Z in a note were listed as expected.
  - All 173 interface tests, 64 WebKit checks and the Rust tests pass; lint is clean.
- **Found along the way:** ⌘Z outside a note (or a text field) does nothing. The brief says
  undo scopes are "chosen by focus", but app actions are only undone from the toast or the Edit
  menu. See the question under Waiting for you.

### R-048 · Swiping in an EPUB sometimes turned several pages
> "Sometimes scrolling pages on epub will turn multiple pages. Please add some kind of pause"

- **Diagnosis:** after you lift your fingers, the trackpad keeps sending a fading stream of
  scroll events (momentum). That stream isn't smooth: it has small bumps. Librarium watches for
  a sudden rise in the stream so that a new swipe during momentum still turns. The bumps were
  big enough to look like a new swipe, so one swipe could turn two or three pages.
- **Changed:**
  - After a swipe turns a page, swiping rests for half a second.
  - A new swipe during momentum must rise clearly (not just a bump) to count.
  - A swipe while a page is still turning isn't saved up for later. The arrow keys still are,
    so quick key presses aren't lost.
- **Use:** nothing new. One swipe turns one page. To go faster, swipe again after a moment or
  use the arrow keys.
- **Code:** `src/reader/epub/engine.ts` (`onWheel`, `SWIPE_REST`).
- **Tested:** a new WebKit check sends a swipe with a long, bumpy momentum tail. Without the fix
  it turns 2 pages; with it, 1. The existing swipe checks still pass, including a new swipe
  during momentum. All 64 WebKit checks, 171 interface tests and the Rust tests pass; lint is
  clean. How it feels on your trackpad can only be judged in the real app; the pause can be
  tuned (`SWIPE_REST`, 500 ms).
- **Left:** nothing.

### R-047 · A PDF capture's highlight broken into words, with a purple box around it
> "How come the highlight is disjoint? And there is a purple box? Should just be a continuous
> highlight right?"

- **Diagnosis:**
  - In a PDF, each word is a separate piece of text with a small gap after it. When a
    capture's boxes were stored, neighbours only joined across 2 px, so the capture was saved
    as one box per word and drawn that way.
  - The purple box was Show's outline around the whole passage. It was meant for picture
    regions and is wrong for text.
- **Changed:**
  - A capture's highlight is one continuous band per line, like a selection. This applies to
    captures saved before the change too: they are joined when drawn.
  - Show puts the passage in the middle of the view and brightens its own lines for about two
    seconds, with no frame. Picture captures keep their outline.
- **Use:** nothing new.
- **Code:** `src/reader/host.ts` (`joinLines`, `flashPlace`, `boxesIn`, `drawMarks`),
  `src/reader/pdf.ts`, `src/shell/shell.css` (`.place-mark`).
- **Decision:** 0052.
- **Tested:**
  - On your Girard capture, using a temporary copy that was deleted afterwards: 19 word boxes
    are now drawn as 5 lines, brightened on Show and back to normal after it.
  - New WebKit checks: per-word boxes are drawn as lines, and Show draws the lines with no
    frame. The earlier check that expected the outline was updated on purpose. All 63 WebKit
    checks, 171 interface tests and the Rust tests pass; lint is clean.
- **Left:** EPUBs and web pages already highlighted continuously, so they are unchanged.

### R-046 · Show in the Girard article went to another page
> "the text capture I made in Girard-DionysusversusCrucified-1984 doesn't localize well -- when I
> click show, it goes to a different page"

- **Diagnosis:**
  - The capture itself was right: its stored place is on page 7, where you made it.
  - The PDF begins with JSTOR's cover page, which is a different size from the article's
    pages. Until PDF.js has read every page, it lays all of them out at the cover's size.
  - Show scrolled to the right spot. Then, as the real page sizes arrived, everything above
    page 7 changed height and pushed the view onto pages 8–9.
- **Changed:** before going to a place, the PDF reader reads the true sizes of every page up to
  it, so the view stays on the place. This applies to any PDF whose first page differs, which
  most JSTOR downloads do.
- **Use:** nothing new. Show (capture page, side panel, embeds) now lands on the passage.
- **Code:** `src/reader/pdf.ts` (`sizedTo`, used by `showPlace`).
- **Tested:**
  - On your Girard PDF, using a temporary copy that was deleted afterwards: the passage is
    outlined in the middle of the view on page 7. Before the fix, the outline sat 838 px
    above the view.
  - A new WebKit check uses a test PDF with a short cover page (`cover.pdf`). It fails without
    the fix and passes with it. All 62 WebKit checks, 171 interface tests and the Rust tests
    pass; lint is clean.
  - Also fixed a type error in the test mock (a wrong error code).
- **Left:** nothing.

### R-042 · Images in notes, kept as attachments in the Library
> "I want image support for notes (images uploaded should be Library items -- perhaps to keep
> things organized, there should be an attachments section of the library that hold things
> uploaded and attached directly to notes -- perhaps they can be promoted to a standalone
> library item that other notes can reference; I'm not sure if this should apply to other kinds
> of files like pdfs/epubs; maybe just stick with images for now)"

- **Changed:**
  - Paste an image into a note, or drop one on it: it's shown in the note and kept in the
    Library's **Attachments** folder (made when first needed). It's still a full library item,
    so other notes can show it too (drag it in, or `![[…]]`).
  - **Move to the Library** (right-click the item) makes an attachment a standalone item: it
    leaves Attachments for the Library's top level, notes keep showing it, and Undo puts it back.
  - PDFs and EPUBs dropped on a note go to the Library's top level, as before (images only, as
    you suggested).
- **Code:** `src/features/library/index.ts`, `tests/mock/backend.ts`.
- **Decision:** 0051.
- **Tested:** an interface test: a pasted image goes into Attachments, is embedded, is
  promoted, and Undo puts it back.
- **Left:** whether PDFs and EPUBs should also become attachments; say if you want that.

### R-040 · A page for captures
> "I want a page that contains, organizes and helps me look for captures. Page icon button
> should be on ribbon"

- **Changed:** a **Captures** page, on the ribbon (the quote icon) and on ⇧⌘K.
  - Search by quote, name, source or place.
  - Arrange **By source** (each book or article heading its captures, which opens it) or
    **Newest first**.
  - Show **All**, **Passages** or **Pictures**.
  - Each capture is a card with its quote (or picture), its name if you gave one, its place
    and date. Click to open it; Show in the source, Edit selection, Copy embed and Delete appear
    on hover; right-click for the menu.
  - Your arrangement and filter are kept on this Mac.
- **Code:** `src/features/captures/index.ts` (the page), `src/shell/shell.css`.
- **Tested:** an interface test: ribbon and ⇧⌘K, grouping, search, the pictures filter,
  newest first (kept), the card's buttons, opening one. Checked by eye in the preview.
- **Left:** searching your words on captures (only quotes, names, sources and places are
  searched now).

### R-041 · Trackpad page turns in books, with an animation
> "I want horizontal scrolling (i'm using mousepad) to work well with flipping pages on epub
> (like apple books); there should be a transition animation; it sometimes works but sometimes
> unresponsive"

- **Diagnosis:**
  1. A sideways swipe also scrolled the book's columns natively, fighting Readium's turn.
  2. After a swipe the trackpad keeps sending a fading stream (momentum) for about a second.
     The one-turn-per-swipe lock waited for it to end, so a quick second swipe was ignored.
  3. A turn asked for while another was under way was dropped.
- **Changed:**
  - A swipe turns one page and the page slides, as in Apple Books (toned down with Reduce
    motion). Its momentum doesn't turn more, but a new swipe does, even mid-momentum.
  - Sideways swipes no longer scroll the columns themselves.
  - Turns asked for during one are kept, one at a time.
  - The arrows, ← → and Space turn with the same animation.
- **Code:** `src/reader/epub/engine.ts` (`flip`, `onWheel`).
- **Tested:** WebKit checks.
  - One swipe (with momentum) turns exactly one page, animated.
  - A second swipe started within the momentum turns again.
  - Every sideways wheel event is kept from scrolling the columns.
- **Left:** how the swipe threshold and the animation's speed feel on your trackpad: easy to
  tune.

### R-045 · PDF text captures: wrong place, highlights off, quotes broken into lines
> "PDF text capture seems to have similar problems: localizing/showing doesn't work well,
> selecting/highlighting the text doesn't seem to match the text that I see, the text referenced
> and quoted shows new lines that doesn't look great and breaks the flow"

- **Diagnosis:**
  - Your article is a scan, with the text from recognition laid over it invisibly.
  - Each line of that text is one string in an unrelated font, with nothing saying where each
    word is, and a bit shorter than the printed line. So selections, highlights and the
    positions stored with captures didn't match what you see, and "Show" missed.
  - Quotes came straight from the page's text, line breaks and hyphens included.
- **Changed:**
  - On scanned pages, Librarium now reads the page image along each line, finds the printed
    words (runs of ink), and puts each word of the hidden text on its printed word. Selecting,
    highlighting, find and Show follow what you see.
  - Quotes read as text: lines are joined, words hyphenated across a line are rejoined
    ("suf-" + "fering" → "suffering"), dashes join, and paragraphs stay. Older captures are
    shown this way too.
- **Code:** `src/reader/pdf-ink.ts`, `src/reader/pdf.ts`, `src/kit/flow.ts`,
  `src/features/captures/index.ts`.
- **Decision:** 0050.
- **Tested:**
  - A WebKit check on a scan-like test PDF: all 96 words within 1.5 pt of the print (12 before).
  - Your article in the real WebKit view: the passage highlighted exactly to each line's end.
  - Unit tests for the quote flowing (your passage's line breaks).
- **Left:** captures you made before keep their old boxes; use Edit selection, or capture again,
  to fix one.

### R-044 · Rename a capture while editing it
> "I want editing the image allow me to (re)name the capture"

- **Changed:** while a capture is edited, its name in the Captures list (side panel) is an
  editable field. Save changes (or Return in the field) saves the new name with the parts.
- **Code:** `src/features/captures/index.ts`.
- **Tested:** an interface test: rename while editing, then save. Typing doesn't redraw the
  list, so the field keeps the focus. One earlier test now reads the name from the field.
- **Left:** nothing.

### R-043 · Editing an image capture shows the old region
> "Editing an image capture doesn't update the capture region as I changed it. I have to save it
> (which doesn't update the region) and then reopen the page. Sometimes I even see the old region
> underneath the new one."

- **Diagnosis:**
  1. Starting an edit shows the capture, which outlined its old region. In PDFs that outline is
     redrawn with every page render, so it sat under the frame being edited, and stayed after
     saving.
  2. The reader didn't record where a part had been dragged to. When pages rendered again (on
     scroll or zoom), the frame went back to the old region, so the next drag, and what you
     saw, started from there.
- **Changed:**
  - While a capture is edited, its place is shown without an outline, and any earlier outline
    is removed.
  - Readers keep each part where it was dragged to (regions, PDF and image passages, EPUB
    passages).
- **Code:** `src/reader/pdf.ts`, `src/reader/image.ts`, `src/reader/epub/engine.ts`.
- **Tested:** a WebKit check: the region is shown (outlined), then edited: no outline under it.
  It's resized, the PDF zoomed (pages render again), and it stays as resized. The check fails
  without the fix.
- **Left:** nothing.

### R-039 · Show with the other buttons on the capture page
> "In the capture page, move the show button on the same row as the other buttons (edit, copy, etc)"

- **Changed:** "Show in the source" is now first in the capture page's header row, with Edit
  selection, Copy embed, Export and Delete. A capture of several separate passages also keeps a
  Show button on each passage, to go to that one.
- **Code:** `src/features/captures/index.ts` (the capture page).
- **Tested:** the capture page test checks the header's buttons and their order, and that a
  one-part capture has no Show beside its quote.
- **Left:** nothing.

### R-038 · The Captures panel jumps to Jobs; editing splits the reader; Show lands elsewhere
> "When I click on a capture, it opens the capture in the main view, but right now the side
> panel goes to "Jobs". It should show the other captures that belong to the same library item
> (it shouldn't actually change the side panel when opening up a capture; maybe just highlight
> the capture opened in the side panel) · editing a capture splits the reader page/panel into
> two (the epub/article, and the capture page). It should just be the epub, and the main side
> panel should remain the list of captures. · Showing the quote doesn't always open up directly
> to the beginning of the quote. … when I click show source on capture page, it opens up to a
> different point each time, but seems to work on the side panel."

- **Changed:**
  - **The Captures list stays.** On a capture's own page, the side panel keeps listing the
    captures from the same source, with the open one highlighted. Each row has Show in the
    source, Edit selection, Copy embed and Delete.
  - **Editing doesn't split the reader.** The book or article stays full width. The capture
    being edited is outlined in the Captures list, with its parts (× removes one) and Cancel /
    Save changes. A small bar over the document has Cancel / Save changes too, and ⌘↩ saves.
    Starting an edit opens the side panel on Captures.
  - **Show from the capture page lands on the passage.** It opens the book fresh, and it used
    to measure the place while the book was still settling: Readium returning to your last
    page, and fonts and images still loading, which moves the layout. It now waits for the
    page to finish laying out, and checks the passage is on screen (correcting if not).
- **Code:** `src/features/captures/index.ts` (the Captures list, edit controls, the edit bar),
  `src/reader/epub/engine.ts` (`laidOut`, `settled`, the on-screen check),
  `src/shell/shell.css`.
- **Tested:**
  - Interface tests: the list stays and marks the open capture; edit mode has no panel beside
    the reader, the bar and the list's editing row work; parts removed from the list. The edit
    tests were updated on purpose: their controls moved from the reader's column to the bar and
    the list.
  - WebKit: all 56 checks, including opening at a place with a remembered reading position
    elsewhere.
  - Checked by eye in the preview.
  - Not reproducible with the test books: the "different point each time" depended on a real
    book's fonts and images loading. Please try Show from the capture page on that book.
- **Left:** nothing.

### R-037 · Drag a passage's end across EPUB page turns
> "support dragging across EPUB page turns"

- **Changed:**
  - While dragging a passage's handle, hold it at the book's left or right edge. The arrow there
    lights up, the page turns after a moment (and keeps turning while you hold), and the passage
    carries on onto the new page. Move into the page and let go where it should end.
  - In scroll view, and in PDFs, saved articles and images, dragging to the top or bottom edge
    scrolls instead.
  - A passage can't span two chapters (each chapter is its own document), so turning stops at the
    chapter's last (or first) page. Add a part in the next chapter for more.
- **Code:** `src/reader/host.ts` (`rangeEditor` edges), `src/reader/epub/engine.ts`
  (`dragEdges`), `src/reader/pdf.ts`, `src/reader/image.ts`, `src/shell/shell.css`.
- **Decision:** a note added to 0049.
- **Tested:** WebKit checks.
  - In a book at 100% and 130%: held at the edge, the arrow lights up, the page turns, and the
    passage carries on from "Paragraph 2." across onto the next page.
  - In a saved article: dragged to the bottom edge, it scrolls and the passage carries on.
- **Left:** how the hold-to-turn timing feels needs your trackpad (about half a second, then
  about one page a second).

### R-036 · Edit a capture's selection; first-class image captures
> "Add copy and delete icons to the capture page, but also, I want to be able to edit the
> selection. In edit mode, I want to be able to drag the boundaries of what's selected, even if
> selection is an aggregate of disjoint selections. I want the UI/UX to be first class. ·
> Ensure first class handling of image captures as well. · Please test PDFs, web articles, and
> epubs according to these things"

- **Changed:**
  - **The capture page** has Edit selection (pencil), Copy embed, Export and Delete icons.
  - **Edit mode:** Edit selection (or Edit in the popover when you click a highlight) opens the
    source at the capture.
    - Every passage gets handles at its start and end, as in Apple Books. Drag one and that end
      follows, snapping to whole words; the highlight follows as you drag. A capture of several
      separate passages has handles on each.
    - Regions (pictures) get a frame: drag a corner or edge to resize, or the inside to move.
      The picture is taken again, sharp, when you let go.
    - The panel beside the document says "Editing", lists the parts (× removes one), and has
      Cancel and Save changes. Select more text, or drag a region, to add a part.
    - Your words and a title you gave stay; an automatic title follows the new quote.
  - **Pictures:**
    - Click a picture in a book to capture it as an image ("Capture image"), or add it to a
      capture.
    - In PDFs, saved articles and images, drag a region as before; regions can now be resized
      and moved.
    - A capture's card in a note shows every part in order, pictures as pictures.
- **Use:** open a capture → pencil. Or click a highlight in the source → Edit. Drag the handles,
  then Save changes.
- **Code:**
  - `src/reader/host.ts` (`editParts`, `rangeEditor`, `regionEditor`, `caretIn`);
  - the readers: `src/reader/pdf.ts`, `src/reader/image.ts`, `src/reader/epub/engine.ts`
    (picture capture too);
  - `src/features/captures/index.ts` (edit mode, the capture page icons, cards with pictures);
  - `crates/features/captures/src/lib.rs` (`captures.update`);
  - `src/shell/shell.css`.
- **Decision:** 0049.
- **Tested:**
  - Interface tests: the whole flow (popover and capture page, dragging, a region resized,
    removing a part, Cancel, Save), picture capture, and cards with pictures.
  - A Rust test for `captures.update`.
  - WebKit checks with real drags:
    - a saved web article (one very tall PDF page): the end handle down a line, the start handle
      past a word, a region resized with its picture re-cut;
    - an EPUB at 100% and 130%: a passage's end dragged, with a new CFI;
    - an image's recognised text, and a region on it;
    - a book picture clicked and captured.
  - Screenshots of the handles in the real WebKit view.
  - Still needs your hands: how the handles feel with a trackpad.
- **Left:** dragging across EPUB page turns came next (R-037).

### R-035 · Show doesn't work well at another text size
> "When font size is different, show doesn't work well"

- **Changed:** "Show" (and find) land on the right page at any text size.
  - At another size, Readium zooms the book page. WebKit then reports positions inside it in
    unzoomed units, with the scroll offset added unscaled. So jumps to a later page (most
    clearly into another chapter) landed short; at 130%, paragraph 71 instead of 95.
  - Positions are now converted to real pixels. Which model the browser uses is detected, not
    assumed.
  - The capture button by a selection is placed correctly at other sizes too.
- **Code:** `src/reader/epub/engine.ts` (`zoomOf`, `onScreenX/Y`, `progressionOf`).
- **Tested:**
  - Screenshots of the real WebKit view (the WebKit runner can now save one: `SNAPSHOT=file.png`)
    at 80%, 100% and 130%: the capture is on screen and highlighted.
  - WebKit checks at 130% in a wide, two-column window, with jumps across chapters: find, Show,
    and opening at a place with a saved size. They fail without the fix. My first versions of
    these checks used the same wrong conversion and passed; they now use the conversion checked
    against the screenshots.
- **Left:** nothing.

### R-034 · Capture buttons feel unresponsive; "Show in the source" doesn't work well
> "Buttons/links for captures ("Show"/"Show in the source", "Copy Embed", "Delete") feel pretty
> unresponsive. Use small icons. · "Show"/"Show in the source" doesn't seem to work well.
> Please diagnose issue(s)"

- **Diagnosis:**
  1. **The source reopened from scratch.** "Show" changed the route's place, and the app treated
     any change as a new page: the whole PDF or book was opened again (slow, and you lost your
     place) before it moved to the capture.
  2. **Asking twice did nothing.** Showing the same capture again (after you'd read on) was the
     same route, so it was ignored.
  3. **PDFs went to the top of the page,** then searched for the quote. A saved web page is one
     very tall page, the search misses words with "ff"/"fi" (R-028), and it finds the first
     occurrence anywhere, so it often didn't reach the passage.
- **Changed:**
  - "Show" moves the document that is already open to the capture, with no reload. It works
    every time, even for the same capture again.
  - In PDFs, "Show" goes straight to where the capture was drawn on the page and outlines it.
    The quote search is only a fallback, for captures made before boxes were kept. In books it
    goes to the exact place (R-033).
  - The capture buttons are small icons with tooltips: Show in the source (target), Copy embed,
    Delete. They're in the Captures panel and on the capture page.
- **Code:** `src/shell/shell.ts` and `src/shell/slots.ts` (pages can take a new place in place:
  `PageHandle.update`), `src/shell/router.ts` (`again`), `src/features/library/index.ts` (the
  item page's `update`), `src/features/captures/index.ts` (icons, places with boxes),
  `src/reader/pdf.ts` and `src/reader/host.ts` (`boxesPlace`).
- **Decision:** 0048.
- **Tested:**
  - An interface test: the source opens once; Show moves it there and again on a second click;
    the place carries the boxes; the tab keeps its title; the panel's buttons are the three named
    icons.
  - A WebKit check: a PDF goes to page 42 with the passage outlined on screen, by its boxes,
    when its quote can't be found.
- **Left:** nothing.

### R-033 · Book page not centred; clicks turn pages; find lands on the wrong page
> "Page is not automatically centered (see photo) · Clicking on page should not navigate to
> next or prev page (only clicking the arrows, or left/right key) · The find tool doesn't seem
> to work perfectly. I searched up a word and find multiple occurrences, some occurrences move
> to a new page where I do not see the word nor any highlight."

- **Changed:**
  - **Centring:** the page is centred in a wide window. Readium narrows its column to the line
    length, and the column sat at the left.
  - **Clicks:** a click on the page no longer turns it. Readium turned pages on clicks in the
    left and right quarters. Only the arrows, the keys and swipes turn pages now; links still
    work.
  - **Find** goes to the page each match is on and highlights it there.
    - It used to ask Readium to look for the match's surrounding text, which sometimes missed
      and landed elsewhere in the chapter.
    - Now it finds the exact match in the page and turns to the page it starts on. That needed
      converting the position into Readium's measure: its progression is over the width that
      can be scrolled, not the whole width.
  - Showing a capture now uses its exact place the same way, with its quote as a fallback.
- **Code:** `src/reader/epub/engine.ts` (`showRange`, `progressionOf`, the click listeners),
  `src/shell/shell.css` (`.epub-stage`).
- **Tested:** WebKit checks on a new long-chapter book: each of three matches on different
  pages is on screen and highlighted after find; a click on the page doesn't turn it; the
  page is centred in a wide window. The click and centring checks fail without their fixes.
- **Left:** nothing.

### R-032 · Changing a book's text size doesn't keep the margins
> "increasing/decreases font size for book reader does not keep padding/margins"

- **Changed:** larger or smaller text now keeps the page's margins and columns, as in Apple
  Books; fewer (or more) words fit a line. Before, Readium scaled the margins with the text, and
  larger text could switch from two columns to one very wide one.
- **Use:** A− / A+ in Aa (or ⌘− / ⌘+).
- **Code:** `src/reader/epub/settings.ts` (`toPreferences`).
- **Decision:** a note added to 0046.
- **Tested:** a WebKit check in a wide window: the margin (56 px), the text width and two
  columns are unchanged at 130%. It fails without the fix.
- **Left:** nothing.

### R-031 · Edit and delete captures; captures in lists and quotes look wrong
> "I want to be able to edit and delete captures. Also, the markdown support of captures is
> pretty iffy (see screenshots) * There's always a line of space above and below the capture
> * The margins/spacing/padding doesn't look right and is off with indents/bullet points, etc"

- **Changed:**
  - Captures in notes sit right beside their bullet or inside their quote, aligned with the
    text, without the empty lines above and below.
  - **Edit:** hover a capture in a note and click Edit, or open it from the Library. Its title
    is editable on its page (Undo works), as are "Your words". The quoted text stays exactly as
    captured; capture again to quote differently.
  - **Delete:** from the capture page (the bin in the header), by right-clicking a capture under
    its book in the Library, from the Captures panel, or by clicking its highlight in a book or
    PDF. Deleting moves it to the archive with Undo; delete it for good from the archive. Notes
    that embed a deleted capture show "In the archive" on its card.
- **Use:** as above. Right-click a capture in the sidebar for Open, Show in the source, Copy
  embed and Delete.
- **Code:** `src/features/captures/index.ts`, `src/shell/shell.css` (`.cm-embed`,
  `.embed-edit`), `tests/captures.test.ts`.
- **Decision:** 0047.
- **Tested:** interface tests for every way to delete, renaming, Edit, and the archived label
  (two existing tests updated on purpose: the popover now also offers Delete, and the caption
  has an Edit button). The layout was checked by eye in the preview with lists, nested lists
  and quotes.
- **Left:** removing one part of a several-part capture (it needs region images renumbered on
  disk); say if you want it.

### R-030 · The book reader, like Apple Books
> "I want the UI/UX to be more like apple books"

- **Changed:**
  - While reading, the toolbar is out of the way. It shows when you move the pointer to the
    top (or while finding, or while a popover is open).
  - Above the page, the chapter's name. Below it, "N pages left in chapter" and how far through
    the book you are. The page's colour fills the whole area, with roomier margins.
  - Arrows at the left and right edges show while the pointer moves; a trackpad swipe turns a
    page.
  - **Contents** (the list button) is a popover with your chapter marked.
  - **Aa** works like Books: smaller and larger A; White, Sepia, Gray and Night (or match the
    app); the Mac's book fonts, each shown in its own face; Scrolling view; and under
    Customise, line spacing, line length, one or two pages, and justified text.
- **Use:** move to the top for the toolbar. ← → or swipe to turn; Aa for settings.
- **Code:** `src/reader/epub/engine.ts`, `src/reader/epub/settings.ts`, `src/reader/host.ts`
  (`immersive`, `controls`, `onPointer`, `onChromeWanted`), `src/features/library/index.ts`,
  `src/shell/shell.css`.
- **Decision:** 0046.
- **Tested:** WebKit checks for immersive chrome, the arrows, the contents popover, the Night
  theme and pages left. Checked by eye in the preview. The feel of the toolbar and swipes
  needs the real app.
- **Left:** a page-turn animation, and a list of a book's captures (like Books' Notes), could
  come next.

### R-029 · A better EPUB reader (Readium)
> "The epub reader is not great. What options do we have?" · "Go with C. I want first class
> experience of captures but also first class reading/viewing experience"

- **Changed:**
  - Books are read with Readium, the EPUB toolkit used by Thorium and many library and
    publisher apps:
    - real pages (two columns on a wide window) or scrolling, as you choose;
    - page turns run straight through chapters;
    - fixed-layout books (picture books, comics) work.
  - Reading settings, kept on this Mac (the **Aa** button): text size, font (the book's,
    serif or sans), spacing, line length, pages or scroll, columns, and theme (follow the
    app, light, sepia, dark).
  - The book reopens where you left it.
  - The bar under the book: previous page, contents, where you are, Aa, next page.
  - Captures work as before, and existing captures keep their places. Select text (it snaps
    to whole words), Capture, save; saved captures are highlighted; clicking one offers to
    open it. Find searches the whole book and highlights the match.
  - Book code still never runs. Books' pages are made inert before they're shown, and their
    script files are never loaded.
- **Use:** open a book. ← → or Space / ⇧Space turn pages; Page Down / Page Up too. Aa for
  settings. ⌘F to find. ⌘+ / ⌘− change the text size.
- **Code:** `src/reader/epub.ts`, `src/reader/epub/` (`engine.ts`, `streamer.ts`,
  `settings.ts`), `src/reader/epub-safe.ts`, `src/reader/host.ts` (`ReaderSource.store`),
  `src/features/library/index.ts`, `src/shell/shell.css`, `src-tauri/tauri.conf.json` (policy),
  `vendor/foliate-js/` (only the CFI module now).
- **Decision:** 0045 (supersedes 0024, and the brief's line naming foliate-js, as you chose).
  Plan: `docs/plans/epub-readium.md`.
- **Tested:**
  - Unit tests for the streamer (manifest, contents, resources, EPUB 2) and for the cleaning.
  - WebKit checks for everything above, including the exact CFI captures get and a
    fixed-layout book.
  - Checked by eye in the preview: settings, sepia, and capturing → saving → highlight →
    "Open capture".
  - Still needs the real app: how page turns and trackpad gestures feel, and real books with
    heavy styling.
- **Left:**
  - Swiping between pages with the trackpad hasn't been checked yet (keys and the buttons work).
  - A built copy of the app needs `npm run build` to pick up the security-policy change.

### R-027 · PDF find highlights off; selecting text hard; captures highlight every other line
> "Highlighting is off (find feature) and selecting text (clicking and dragging) is not very
> easy to use (do quick research for best practices of UI/UX for selecting text)" ·
> "Also, capturing text highlights weirdly"

- **Changed:**
  - Find highlights sit exactly on the words. The hidden, selectable copy of the text was
    about 2% larger than the page you see, so everything drifted towards the bottom right.
    It now lies exactly over the page.
  - Each word of that hidden text is placed using the PDF's own letter widths, so it lines up
    within lines too (it was off by up to half a letter in web fonts).
  - Dragging to select is easier to aim, since you're grabbing the letters you see. Drags snap
    to whole words, as in Books and Kindle.
  - Capturing several lines highlights every line (it skipped every other line on long saved
    pages).
  - Find shows all matches in soft yellow and the current one in orange with a ring; the
    selection uses the app's selection colour.
- **Use:** as before. Find with ⌘F, Return / ⇧Return for next / previous; drag to select, then
  Capture.
- **Code:** `src/reader/pdf.ts`, `src/reader/pdf-words.ts`, `src/reader/host.ts` (`boxesIn`,
  `snapToWords`), `src/reader/epub.ts` (snapping), `src/shell/shell.css`.
- **Decision:** 0044.
- **Tested:** unit tests (word placement, line boxes on a tall page, word snapping). WebKit
  checks: the text layer lies exactly over the page (it fails with a border) and is in words.
  Checked by eye on your saved Thiel–Döpfner page in the preview. How dragging feels needs
  the real app.
- **Left:**
  - Captures made before this keep their old boxes; re-capture to fix one.
  - Find misses words with some ligatures in saved pages (R-028, in the Inbox).

### R-026 · EPUBs show only their first page
> "I only see the first page of the epubs"

- **Changed:**
  - Books now read on. Scroll past the end of a chapter (pause, then keep scrolling) and
    the next chapter opens; scroll up past the start for the previous one.
  - A bar under the book has the previous chapter, the contents (a list to jump to any
    chapter) and the next chapter.
  - The cause went deeper than missing buttons. WebKit ignored every event inside book pages,
    because they were sandboxed without scripts. That also broke keys, and starting a
    capture from a selection in a book. Book pages now handle events, and the book's own
    scripts are stopped in three other ways.
- **Use:** scroll on, or Space / Page Down / Page Up; ← and → turn chapters; the bar's
  Contents list jumps anywhere.
- **Code:** `src/reader/epub.ts`, `src/reader/epub-safe.ts`, `vendor/foliate-js/` (sandbox,
  PATCHES.md), `src/shell/shell.css` (`.epub-bar`).
- **Decision:** 0043.
- **Tested:** WebKit checks: the contents, next, ←, scrolling on, and that scripts, handlers
  and `javascript:` links never run and every page has the policy. Unit tests for the cleaning.
  The feel of trackpad scrolling past a chapter's end needs the real app.
- **Left:** selecting and capturing in books should be retried in the real app now that
  events arrive.

### R-025 · The app icon
> "add this" (librarium-icon-kit.zip) · "sorry, this is better"
> (librarium-refined-icon-kit.zip) · "I still see this" (the old purple Dock icon) ·
> "This is better" (librarium-bold-icon-kit.zip)

- **Changed:**
  - Librarium's icon is the bold kit's **Evergreen & gold** (thicker strokes, re-centred; gold book-and-house on deep
    green), the kit's recommendation for the app icon.
  - It is placed on macOS's icon grid, with the standard transparent margin, so it sits the
    same size as other apps in the Dock.
  - The welcome screen shows the mark.
  - The whole kit is kept in the project, so another colourway is a quick swap.
  - The old icon stayed in the Dock because the app wasn't rebuilt when its icons changed; it
    now is (`src-tauri/build.rs`).
- **Use:** the development app shows it after its next rebuild. The built `Librarium.app`
  gets it at the next `npm run build`.
- **Decision:** 0042.
- **Code:** `assets/brand/` (the kit, `app-icon-macos.svg`, and a README on regenerating);
  `src-tauri/icons/`; `src/kit/logo.ts`.
- **Tested:** all interface tests pass. The icon itself shows only in the real app.
- **Left:** to use another colourway (Parchment, Midnight, Aubergine, Terracotta), say which.

### R-022 · The keychain prompt while saving web pages
> "Please explain web encryption for saved pages?" · "Is it dangerous to turn it off?" ·
> "yes" (option 3: turn it off while saving)

- **Changed:**
  - Pages being saved no longer see the browser's encryption feature (Web Crypto). No page
    can keep a key, so WebKit has no reason to ask the keychain for its "WebCrypto Master
    Key".
  - Only the hidden saving window is affected: not your browser, keychain, library or the
    rest of the app. Random numbers still work.
- **Use:** nothing to do. If a saved page ever comes out blank or incomplete, its snapshot
  says so; save it again.
- **Code:** `HIDE_WEB_CRYPTO` in `crates/adapters/pagesaver-webkit/src/lib.rs`; the test page
  `tests/fixtures/pages/crypto.html`.
- **Decision:** 0041 · **Tested:** in real WebKit, a page being saved sees no Web Crypto and
  still has random numbers. That the prompt never appears can only be seen in the real app:
  please say if it ever does.

### R-021 · Images in notes
> "images stored as library items"

- **Changed:**
  - Pasting an image into a note, or dropping image files from Finder onto it, adds each to
    the Library (the original kept byte for byte) and puts `![[title|id]]` on its own line
    where it went.
  - The note shows the image itself; a click opens it in the reader.
  - PDFs and books dropped into a note show as a card.
  - A clipboard image is named "Pasted image <date and time>".
- **Use:** ⌘V an image (e.g. a screenshot) into a note, or drag files from Finder onto the
  text. `![[` also offers library items to embed.
- **Code:**
  - `library.importData` in `crates/features/library/src/lib.rs`.
  - The paste and embed events in `src/editor/editor.ts`.
  - Import, drop and the image embed in `src/features/library/index.ts`.
- **Decision:** 0040 · **Tested:** a pasted image becomes an item and is embedded in the note
  (Vitest); checked in the preview. Dropping from Finder can only be tried in the real app:
  please try it.
- **Left:** resizing an image in a note.

### R-024 · The side panel
> "Really don't like side panel" (screenshot 2026-10-03: everything stacked in one column,
> Jobs full of "Refreshing link labels"). Chosen: "Panel, one view at a time".

- **Changed:**
  - The panel shows one view at a time, chosen by icons along its top: Links (what links
    here, plus a note's links without a target), Outline, History, Captures and About (for
    library items), and Jobs. Only views that apply to the page are offered.
  - The panel remembers your choice and starts closed.
  - Repeated finished jobs show as one line ("Refreshing link labels · 12 times, last at
    11:24 PM").
- **Use:** ⌥⌘\ or the button at the top right opens and closes the panel. Click an icon (or
  use the arrow keys on them) to switch views. ⌥⌘Y opens it on History, and the status bar's
  jobs button opens it on Jobs.
- **Code:** the panel in `src/shell/shell.ts` ("One view at a time"),
  `SidePanelSection.icon` in `src/shell/slots.ts`, the Links view in
  `src/features/links/index.ts`, grouping in `src/shell/jobs.ts`.
- **Decision:** 0039 · **Tested:** a new panel test; two tests updated on purpose (the jobs
  view is found by its section, and the captures test opens the Captures view); all 151
  interface tests pass; checked in the preview.

### R-023 · No duplicate tabs
> "Don't see in a point of duplicate tabs (two tabs of the same file/page)" (screenshot
> 2026-10-03: three tabs of the note 2026-10-03)

- **Changed:** two tabs never show the same note, item or page.
  - Opening something already open in another tab (clicking it, "Open in new tab", a
    middle-click, a link, ⇧⌘T) shows that tab instead, moved to the place asked for (a search
    hit's position, a snapshot). The tab you were in stays where it was.
  - Tabs saved with duplicates come back once each.
  - ⌘T with a "New tab" already open shows that one.
- **Use:** nothing to do; it just doesn't duplicate.
- **Code:** `src/shell/router.ts`: `placeOf` (a record by its ID, a page by its params), and
  checks in `go`, `reopen` and `restore`.
- **Tested:** new router tests (going, "in a new tab", reopening, restoring saved duplicates);
  all interface tests pass.
- **Left:** back and forward inside a tab can still land on a page that another tab shows (a
  tab's own history is left as it was).

### R-020 · Fold lists and headings like Obsidian
> "Doesn't look great how bullet lists are collapsed including nested lists"

- **Changed:** the fold arrow now sits just left of each bullet or heading (not in one column
  at the far left); it shows on hover and while folded. A folded line ends in a faint "…"
  (click to unfold) and its bullet gets a ring.
- **Use:** hover a list item or heading and click its arrow; ⌥⌘[ / ⌥⌘] at the cursor.
- **Code:** `src/editor/folding.ts`; styles in `src/shell/shell.css` ("Folding").
- **Commits:** `4f1c144` · **Decision:** 0037 · **Tested:** interface tests; checked in the
  preview (positions measured).

### R-019 · Nested bullet lists were misaligned
> "Why is the bullet list so messed up"

- **Changed:** a list item's indentation and marker are drawn in the monospace font, so each
  level steps in evenly; wrapped lines hang under the item's text; the bullet no longer
  inherits the line's negative indent.
- **Code:** `src/editor/lists.ts` (`hangingIndent`), `.cm-list-prefix` / `.cm-bullet` styles.
- **Commits:** `058e849` · **Decision:** 0037.

### R-018 · First-class writing, and version history
> "Create a well-designed plan for the editor + version control. Compact, then implement."
> Decisions: `.librarium` is acceptable; delete permanently erases a note's history;
> retention as proposed.

- **Changed (editor):** live preview per construct (link IDs never shown); ⌘B ⌘I ⇧⌘X ⇧⌘H ⌘E
  ⌘K ⌘L ⌥⌘1–6 ⌥⌘0 and a Format menu; wrapping a selection with `* _ = \` ~`; multiple
  cursors (⌘D, ⌥-click, ⌥-drag); Tab/⇧Tab move list items with children, renumbering; HTML
  pasted as Markdown, ⇧⌥⌘V plain; copy gives `[[label]]` to other apps; code highlighting;
  folding; word count; Outline panel; clicking an unresolved link makes the note; custom link
  text survives renames.
- **Changed (history):** notes, daily notes and captures keep versions in
  `.librarium/history` (one log per Mac; safe with iCloud); spaced 5 minutes while writing,
  plus outside edits and restores; retention: all for a day, hourly for a week, daily for 90
  days, weekly after. History (⌥⌘Y) compares and restores (with Undo); Archive lists notes
  deleted outside the app and brings them back.
- **Code:** `src/editor/*` (one file per part), `crates/kernel/src/history.rs`, the history API
  in `crates/api/src/lib.rs`, `src/features/notes/history.ts`.
- **Commits:** `4531f98` (plan, developer guide) `b2cd668` `c987ad6` `fde3541` `1fe30d3`
  `6baae12` `fa33650` `13c19b8` · **Decisions:** 0037, 0038 · **Plan:**
  `docs/plans/editor-and-history.md` · **Tested:** Vitest (editor, clipboard, lists, history
  UI), kernel and API tests (history, retention, two Macs, deletion).
- **Left:** hover previews, callouts, `#tags`, images in notes (R-021), tables, properties,
  templates, math, focus mode; history for library items.

### R-017 · Research Obsidian's editor and version control
> "Please research Obsidian markdown editor quality/features…" · "Research deeply also how
> Obsidian handles version control"

- **Done:** two research reports; their findings and choices are in
  `docs/plans/editor-and-history.md`, decisions 0037 and 0038. Led to R-018.

### R-016 · Links opened inside the app, with no way back
> "I clicked a link inside the app, and it took me to a webpage… it should ask if I want to
> open it (in a browser) with details about the link"

- **Changed:** a link to the web asks first: its words, where it goes, the full address, from
  which page, a warning if misleading or not secure; Cancel / Copy link / Open in browser. The
  window can never navigate away (a guard in the app).
- **Code:** `src/shell/links.ts`, `src-tauri/src/lib.rs` (`stays_in_app`), `app.openUrl`.
- **Commits:** `829695c` · **Decision:** 0036.

### R-015 · Daily notes as ordinary notes
> "No need to create a special folder/group… a button on the ribbon to create a new daily
> note (or open it)… lands in the root… treated just like a note"

- **Changed:** no Daily notes group; Today (ribbon, ⇧⌘D) opens or makes today's note at the
  top level of Notes; it is a normal note that still knows its day (`daily.date`).
- **Commits:** `6eb8698` · **Decision:** 0035.

### R-014 · Tabs like Obsidian
> "Please add tabs support like Obsidian"

- **Changed:** a tab bar; each tab has its own history and keeps its page alive; ⌘T new, ⌘W
  close, ⇧⌘T reopen, ⌃Tab / ⌘1–9 switch; middle-click and "Open in new tab"; tabs restored
  on start. Today moved to ⇧⌘D; Close window is ⇧⌘W.
- **Code:** `src/shell/router.ts`, `src/shell/tabs.ts`, page hosting in `src/shell/shell.ts`.
- **Commits:** `5c3a3c8` · **Decision:** 0034.

### R-013 · Notes and Library each with their own folders; captures under items
> "Just a notes panel with their own folders and a library panel… captures… should be
> children of the library items" (and: the Notes page said "No notes yet")

- **Changed:** separate folders per kind; the Notes and Library pages are the Finder-like
  browser; sidebar has just Notes and Library; captures fold under their item; daily notes
  shown, empty-folder note under the header.
- **Commits:** `14eceb9` `084572c` · **Decision:** 0033.

### R-012 · Arrange items by hand
> "Please support positional dragging"

- **Changed:** drop on the top/bottom edge of a row (left/right of an icon) to place it; the
  folder switches to "As arranged"; ⌥↑/⌥↓ moves the selection; kept in
  `.librarium/order.json`.
- **Commits:** `1d43723` · **Decision:** 0033 (addendum).

### R-011 · Folder organisation like Finder or Google Drive
> "Please add support for and improve UI/UX for folder/file organization and navigation"

- **Changed:** real folders for notes and library items; a browser with list and icon views,
  path, sort, filter, selection (clicks, box, keyboard), rename in place, context menus,
  drag and drop (pointer-based), Undo.
- **Code:** `crates/kernel/src/folders.rs`, `src/shell/folders/`, `src/kit/dnd.ts`.
- **Commits:** `ecddab4` · **Decision:** 0033.

### R-010 · Highlight saved captures in the reader
- **Changed:** captures show as soft highlights in PDFs, images, saved pages and books; a click
  offers "Open capture". · **Commits:** `ae34d22` · **Decision:** 0031.

### R-009 · Popups in saved pages; fade-in text; slow saves
> "Popup was saved…" · "This is unacceptable" · "Is there a way to speed up… webpage saving?"

- **Changed:** popups removed even while fading in or arriving late; animations stilled;
  hidden text revealed; the right main text; saving 5–20× faster; Cancel stops a save at once.
- **Commits:** `95d00b2` `0aaeae2` `e2efad3` `b427d3c` `ed2c0d2` `d6a28ac` `bb44195` ·
  **Decisions:** 0027, 0030.

### R-008 · Jobs: failures explained, stop them (all at once)
> "Why does it still say 5 failed… no information" · "How can I stop jobs" · "Especially
> mass stop"

- **Changed:** failed jobs say why, with Retry and Dismiss (all); Cancel and Cancel all;
  open and close the side panel. · **Commits:** `473ca61` `750b922` `368b7b2`.

### R-007 · Remove old snapshots; select several; select mode
> "Please first add a way to remove them. Support multi-selection" · "Add select mode where
> cmd-a works"

- **Commits:** `34dac57` `73b925f` `473ca61` · **Decision:** 0032.

### R-006 · Archive and delete from a right-click
- **Commits:** `4142db0` · **Decision:** 0029.

### R-005 · Save the whole link list; skip duplicates; stay in the background
> "Please add all articles from link list" · "does it have duplicate detection?… not popup
> everytime"

- **Commits:** `6e41037` `3e695c1` `bac5233` `cf1f886` `b6e2553` `33584c6` ·
  **Decision:** 0027.

### R-004 · Easier captures (several parts, regions that work)
- **Commits:** `2f94239` · **Decision:** 0031.

### R-001 – R-003 · The original build (milestones 0–9) and the real-pages check
- From `PROMPT.md` and `BRIEF.md`; see the README's decision table (0001–0030).
