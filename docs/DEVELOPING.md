# Developing Librarium

A guide for whoever works on Librarium next: what exists, where it lives, why it is shaped
that way, and what has been learned the hard way. `BRIEF.md` is the reference for intent;
`docs/decisions/` records each decision (the README lists them); `docs/plans/` holds work in
progress; `docs/REQUESTS.md` is where the user writes requests and each one's answer is kept.
Read this first, then the brief.

## 1. What the app is

A macOS desktop app (Tauri 2) for notes and a reading library, for one person:

- **Notes** in Markdown, in folders, linked with `[[label|id]]`; daily notes are notes that
  know their day.
- **A library** of PDFs, images, EPUBs and saved web pages (a faithful PDF snapshot plus clean
  text), read in one reader.
- **Captures**: exact quotations (text or regions) from library items, anchored with W3C
  selectors, embedded in notes with `![[…]]`.
- **Search** across everything, **backlinks**, an **archive** (two-step deletion), **jobs**
  (page saving, text extraction, recognition) and **tabs**.

Everything the user owns is plain files in a folder they chose (§5.1 of the brief). The app's
own data (index, drafts, intents, jobs, settings) lives in
`~/Library/Application Support/local.librarium.desktop/` and is never synced.

## 2. Running, testing, linting

See the README's command table. In short:

- `npm run dev` runs the app (Vite + `tauri dev`). **Rust edits rebuild and restart it**;
  interface edits hot-reload. Don't experiment in the working tree while the user is using
  the dev app: their window restarts.
- `npm run dev:mock` serves the interface alone on port 1421 against the mock backend
  (`tests/mock/backend.ts`), with a sample library. Use it for visual checks.
- `npm test` = `test:web` (Vitest in jsdom; the timing-sensitive `perf` and `shell` tests run
  in a second, sequential pass), `test:webkit` (real WebKit checks of the reader,
  `tests/webkit/`), and `cargo test --workspace`.
- `npm run lint` = ESLint + dependency-cruiser (direction rules) + clippy `-D warnings` +
  rustfmt.
- `npm run gen:types` after changing any type in `crates/contracts` that is exported to
  TypeScript (list in `crates/contracts/src/typegen.rs`).

Practical notes:

- **Disk space.** `target/` grows past 20 GB; `cargo clean` is safe. A full build needs a few
  GB free.
- **Load-sensitive tests.** Under heavy load (a Rust build, Time Machine), interface tests
  time out at 5 s. Rerun on a quiet machine before believing a failure.
- **Never run `page_probe` (src-tauri/examples) against real websites** on the user's Mac.
  Saving now hides Web Crypto from pages (0041), which should stop WebKit's keychain prompt
  for a "WebCrypto Master Key", but the user denies those prompts. Use the local fixtures.

## 3. Architecture

Ports and adapters, in rings; dependencies point inward, towards `contracts`
(Rust: `src-tauri/tests/direction.rs`; interface: `.dependency-cruiser.cjs`).

```
crates/contracts   types, IDs, events, errors, port traits, slot names, API messages
crates/kernel      store (records, writer, intents, identity), startup check, folders,
                   changes, drafts, merge, jobs host, derived-view host, registries
crates/api         the application API (plain Rust; tests call it directly)
crates/adapters/*  one crate per real adapter of a port (fs-macos, changes-fsevents,
                   index-sqlite, pagesaver-webkit, recognizer-vision, system, transport-tauri,
                   worker-process, versions-none)
crates/features/*  notes, daily, library, captures, search, links, archive
crates/testkit     test adapters for every port, shared port suites, fixtures
crates/worker      a separate process that runs parsers (PDF text, EPUB…); never the app
src-tauri          the composition root (`compose.rs`): the only place naming adapters
src/               the interface: shell/ kit/ editor/ reader/ features/
```

Rules that keep it honest:

- **Features never name each other.** They meet through *slots* (registries): kernel slots
  (`kernel.record-kinds`, `kernel.api-methods`, `kernel.job-kinds`, `kernel.part-users`, …)
  and interface slots (`shell.pages`, `shell.actions`, `shell.sidebar-sections`,
  `shell.record-actions`, `shell.record-looks`, `shell.editor-extensions`,
  `shell.reader-engines`, `shell.embeds`, `library.item-children`, `library.reader-tools`,
  …; list in `src/shell/slots.ts`). The architecture report (`npm run arch-report`) shows
  who fills what.
- **The kernel names no feature**, not even in a string (guard in `direction.rs`).
- **Only `src/backend.ts` talks to Tauri.** Tests alias it to the mock backend.
- **The path is the truth for a record's folder; everything else points at IDs.** IDs are in
  each file (frontmatter `id:` or `record.json`).

## 4. The store (kernel)

- **Records.** Kinds are contributed by features: Markdown (`notes/…/<id>-slug.md`,
  `captures/<id>.md` plus sidecars) or folder records (`items/…/<id>-slug/record.json` with
  binaries). A kind with a `subfolder_field` lives in the user's folders (notes, items).
- **Writes** go through one writer thread with two lanes (interactive first). Every multi-file
  operation is an **intent** written to Application Support first and redone at startup
  (`Intent::{Relocate, Identify, Delete, MoveFolder}` in `store.rs`). Files are written by
  temp-file + rename + `F_FULLFSYNC` (decision 0007). Crash sweeps (`crates/kernel/tests/
  crash`) cut the power at every step against a file system model, and kill -9 against a
  real one.
- **Startup check.** Outside edits are found by FSEvents replay, or by a full check after an
  unclean shutdown (0008). Duplicate IDs (sync conflict copies) are classified (0009).
- **Saving a note** compares versions (content hashes). An outside change in between is
  merged three-way (`merge.rs`), or offered as a conflict; drafts survive a crash (0017).
- **Folders** (`folders.rs`, 0033): each foldered kind has its own folders; create, move
  (one intent), remove (only when empty), and the hand arrangement in
  `.librarium/order.json`.
- **Archive and deletion** (0029): archiving sets `archive.at`; permanent deletion needs an
  archived record and a single-use token from a confirmation, then is an intent.
- **Version history** (`history.rs`, 0038): Markdown records' versions in the library's
  `.librarium/history/` (objects by sha256, one JSONL log per Mac); taken after app writes
  (spaced 5 minutes, finished by the maintenance tick), on outside changes and around
  restores; pruned by age; erased by permanent deletion; deleted notes can be brought back.

## 5. Features (backend)

- **library**: import (staging, one rename, text extracted in the worker; 0022); saving web
  pages in a hidden WebKit window (`pagesaver-webkit`; 0027, 0030): the page is loaded in an
  incognito store, popups and overlays are removed, animations stilled, lazy images forced,
  then printed to PDF and its text read with PDFKit; checks flag paywalls, sign-in walls,
  errors, canvas-drawn pages and incomplete loads; snapshots are dated folders and older ones
  can be removed (0032). Text recognition with Apple Vision (0028).
- **captures**: quotes and regions with W3C selectors and sidecars (0025, 0031), what parts
  of items they use (`kernel.part-users`), `captures.forSource` for highlights.
- **links**: backlinks and the label-repair job (0020).
- **search**: SQLite FTS5 index as a derived view (0018).
- **daily**: `daily.today` makes or finds today's note (0035).
- **archive**: archive, restore, prepare-delete, delete.

## 6. The interface

- **Shell** (`src/shell/shell.ts`): layout (ribbon, sidebar tree, tabs, page, side panel,
  status bar), the action registry (one place for shortcuts, the palette, the native menu;
  collisions rejected), prefs (per device), records cache (kept current by change events),
  undo for app actions (with a session log, `undo.log`, shown by the temporary Undo history
  view, `src/features/undo-history/`, 0053), jobs UI.
- **Tabs and navigation** (`router.ts`, `tabs.ts`, 0034): each tab has its own history and a
  living page (hidden when another tab shows); `router.go(page, params, {newTab, again})`;
  tabs are restored at start. A page can return `{ dispose, update }` to take new params for
  the same record without rendering again (0048); the item page moves its reader.
- **Folders service** (`src/shell/folders/`, 0033): Notes and Library add themselves as
  folder spaces and get a Finder-like page (list/icons, sort, filter, selection, renaming,
  context menus, a selection bar) and a sidebar tree. Dragging uses pointer events
  (`kit/dnd.ts`) because Tauri claims the platform's drags for file drops.
- **Links to the web** (`links.ts`, 0036): a dialog asks before opening in the browser; a
  Tauri navigation guard keeps the window in the app.
- **Editor** (`src/editor/`, 0037): CodeMirror 6.
  - `livepreview.ts`: marks hidden per construct, link IDs atomic.
  - `format.ts`: formatting commands, the Format menu, wrapping, multiple cursors.
  - `lists.ts`: subtree indent, renumbering, hanging indent.
  - `clipboard.ts` and `html2md.ts`: HTML pasted as Markdown, copying without IDs.
  - `code.ts`: language highlighting, folding.
  - `stats.ts`: counts and the outline.
  - `complete.ts`: `[[` completion; plus embeds from extensions.
  - The note page (`features/notes/page.ts`) adds autosave, the word count, and making notes
    from unresolved links. `features/notes/history.ts` is the History panel.
- **Reader** (`src/reader/`): PDF.js (legacy build), images, EPUB with Readium; marks for
  captures; region capture. PDF text is placed word by word over a borderless page
  (`pdf-words.ts`, 0044); mouse selections snap to words (`snapToWords`).
  - **EPUB** (0045): `epub.ts` loads `epub/engine.ts` on first use. `epub/streamer.ts` serves
    the book from memory (OPF → manifest, chapters made safe by `epub-safe.ts`, resources as
    blob URLs). `epub/settings.ts` holds the reading settings and their panel. Captures use the
    same CFIs as before (`vendor/foliate-js/epubcfi.js`); marks and find are drawn with
    `CSS.highlights` in Readium's frames. Settings and places go through `ReaderSource.store`.
    Readers can edit a capture's parts in place (`editParts`, with `rangeEditor`,
    `regionEditor` and `caretIn` in `host.ts`; 0049).
    The chrome follows Apple Books (0046): readers can be `immersive` (the library page's
    toolbar shows on approach) and add their own toolbar `controls`.
- **Kit** (`src/kit/`): small, dependency-free pieces (signals, DOM helper, dialogs, menus,
  combobox, tree (virtualized), selection, select list, drag and drop, toasts).

Accessibility is tested (axe in Vitest, APG patterns for tree, listbox, tabs, menus,
combobox). Every action must be in a menu (shell test).

## 7. Lessons learned (keep these)

- **Tauri and the web view**
  - Creating a webview activates the app: the page saver's hidden window is made once at
    startup and reused, or the app jumps in front of whatever the user is doing.
  - Timers are throttled in hidden windows: the page script uses MessageChannel yields, not
    `setTimeout`.
  - Tauri's file-drop handler claims every drag over the window, so HTML5 drag and drop
    inside the page never drops. Use pointer events.
  - A link can navigate the whole window away; the navigation guard prevents it.
  - The development Dock icon is `icons/icon.icns`, baked into the binary at compile time;
    `src-tauri/build.rs` reruns when `icons/` changes so a new icon shows after the restart.
- **WebKit, PDFs and saved pages**
  - In an iframe sandboxed without `allow-scripts`, WebKit runs no event listeners at all, not
    even the parent's (bug 218086). Stop a book's scripts by other means (0043, 0045).
  - Measure a place in a book only once its page has laid out (`laidOut`: fonts and images
    loaded). Just after opening, Readium is still going to the remembered page, and a real
    book's layout moves as its fonts and pictures arrive.
  - Readium's progression is the distance scrolled over the distance that can be scrolled
    (the width less one page), and its text search can miss. To show a range, find it in the
    page and go to its page by progression (`showRange`).
  - At a text size other than 100%, Readium zooms the page body, and WebKit reports positions
    inside it in unzoomed units with the scroll added unscaled: on screen = (x + scroll) × zoom
    − scroll (`zoomOf`). Check layouts by eye: `SNAPSHOT=out.png swift scripts/webkit-run.swift
    URL 60` saves a picture of the page once it sets `window.__result`.
  - Readium turns pages on clicks in the outer quarters unless the `click`/`tap` listeners
    return true. It sets its container's width to the column; the host centres it.
  - Readium doesn't size its frames: the host's CSS must (they default to 300 × 150, which
    lays a chapter out in a tiny box with extra pages).
  - Blob-URL frames inherit the app's Content Security Policy in built copies (the dev app has
    none), so anything book frames load must be allowed there too (`blob:`).
  - `pdf-extract` reads nothing from WebKit's PDFs; PDFKit does.
  - Count images inside Form XObjects.
  - Strip soft hyphens.
  - PDF.js's text layer must be exactly the drawn page's size: a page border (or any CSS that
    resizes `.page`) makes find and selection drift. PDF.js's stylesheet loads after ours.
  - A scan's recognised text (invisible, render mode 3) often has no word positions at all:
    align it to the ink of the rendered page (`pdf-ink.ts`, 0050).
  - PDF.js lays out pages it hasn't read yet at the first page's size; where that differs (a
    JSTOR cover page), a scrolled-to place drifts as real sizes arrive. Size the pages up to a
    place before going there (`sizedTo` in `pdf.ts`, R-046).
  - Judge "same line" in pixels, never in percent of a page: saved web pages are one page
    thousands of pixels tall.
  - WebKit's saved PDFs map some ligatures wrongly in PDF.js ("ff" reads as "S"), so find
    can miss words with ligatures (R-028).
  - Popups fade in through `requestAnimationFrame` (paused when hidden), so remove dialogs
    regardless of visibility; watch only changed elements on busy pages.
- **The editor**
  - A replace widget inside a line must not be `display: block`: the line breaks into empty
    line boxes around it, and it inherits the line's hanging indent. Embeds are inline-blocks
    filling the rest of the line (0047).
- **Signals**
  - An effect only re-runs for what it read on its last run. Read your signals before any
    early return (a bug once froze the folder page after a rename).
  - Change related signals in one `batch` (the router changes the route and the active tab
    together).
- **Tests and the machine**
  - Synthetic events can't test native drag and drop, keychain prompts or Tauri's drag
    handling. Say so, and ask the user to try such things in the real app.
  - Timing tests fail under load.
  - The app's preview pane only renders while it's on screen: PDF pages and text layers wait
    for a screenshot there. That isn't slowness in the app.

## 8. Conventions

- Commit messages are plain and end with the co-author line given in the session.
- Never weaken a test. When behaviour changes on purpose, update the test to the new
  behaviour and say so in the commit.
- Record every decision (MADR style, `docs/decisions/NNNN-title.md`) and add a README row.
- Ask the user only where the brief says to; never touch files outside the project folder,
  the user's library folder and the app's own folders; never delete user data without the
  two-step confirmation.
