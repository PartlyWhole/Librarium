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

(nothing)

---

## In progress

### R-040 · A page for captures
> "I want a page that contains, organizes and helps me look for captures. Page icon button
> should be on ribbon"

### R-042 · Images in notes, kept as attachments in the Library
> "I want image support for notes (images uploaded should be Library items -- perhaps to keep
> things organized, there should be an attachments section of the library that hold things
> uploaded and attached directly to notes -- perhaps they can be promoted to a standalone
> library item that other notes can reference; I'm not sure if this should apply to other kinds
> of files like pdfs/epubs; maybe just stick with images for now)"

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
