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


---

## Waiting for you

(nothing)

---

## In progress

(nothing)

---

## Done

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
