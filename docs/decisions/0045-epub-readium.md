# 0045. EPUBs are read with Readium

- Status: accepted. Supersedes 0024 (foliate-js) and the brief's §3 line naming foliate-js:
  the user chose Readium ("Go with C. I want first class experience of captures but also
  first class reading/viewing experience").
- Date: 2026-10-04
- Request: R-029 in `docs/REQUESTS.md`; plan `docs/plans/epub-readium.md`

## Context and problem

The foliate-js reader showed one chapter at a time, had no reading settings, and its frames
made selection, highlights and find fragile. Options weighed: polish foliate-js, render books
ourselves, Readium, or hand books to Apple Books. The user chose Readium, the EPUB toolkit used
by Thorium and many library and publisher apps (`@readium/navigator`, BSD-3-Clause, actively
maintained).

## Decision

- **Readium's navigator** lays books out with Readium CSS: pages (two columns when wide) or
  scrolling, page turns across chapters, fixed-layout books. The engine is
  `src/reader/epub/engine.ts`, loaded the first time a book opens (`src/reader/epub.ts`).
- **No server.** Readium expects a manifest and resources it can fetch by address.
  `src/reader/epub/streamer.ts` does that work in the page:
  - it unzips the book on demand (fflate, MIT) and turns the OPF into a Readium manifest
    (reading order, resources, contents from the EPUB 3 nav or the EPUB 2 NCX, positions);
  - its Fetcher serves chapters made safe, with every resource (images, stylesheets, fonts,
    media, and what stylesheets use) as a blob URL;
  - chapter links stay relative to `https://book.librarium.invalid/<id>/`, which never resolves,
    and Readium turns clicks on them into navigation.
- **Security** (extends 0043). Readium runs its own scripts in book frames, as blob URLs. Book
  code is made inert before Readium sees a page (`epub-safe.ts`):
  - script elements are emptied and given an inert type, kept in place so CFI paths don't move;
  - frames and plugins lose their sources, and `<base>`, refresh `<meta>`, `on…` handlers and
    `javascript:` links are removed;
  - the book's script files are never served;
  - every page gets a policy allowing scripts only from blob URLs, with no plugins, frames,
    workers or forms. Readium's own policy also applies.
  The app's own policy (used in built copies) gains `blob:` for scripts, frames, fonts and
  media, which book frames inherit. Only the app's code can make blob URLs.
- **Captures unchanged.** A selection gives the same EPUB CFI as before, made with foliate-js's
  `epubcfi.js` (kept; the rest of foliate-js is removed) from the spine item's CFI in the
  package document. So captures made with the old reader still resolve.
  - Showing a capture goes by its quote (Readium finds text in the chapter).
  - Marks and find matches are drawn with the CSS Custom Highlight API inside Readium's frames.
  - Clicking a saved highlight is detected from the caret position.
  - Mouse selections snap to words.
- **Reading settings**, per device (the shell's prefs, `reader.epub`): text size, font (the
  book's, serif, sans), spacing, line length, pages or scroll, one or two columns, and theme
  (follow the app, light, sepia, dark). The place in each book is remembered
  (`reader.place.<id>`). Readers get these through a new optional `ReaderSource.store`.
- **The bar under the book**: previous, contents, where you are, reading settings, next. Keys:
  ← →, Space / ⇧Space, Page Down / Page Up.

## Consequences

- Readium sizes nothing itself: the host's stylesheet makes reflowable frames fill the stage
  (`.epub-stage > iframe.readium-navigator-iframe`). Without that, frames are 300 × 150.
- WebKit checks cover opening, page turns into the next chapter, keys, contents, find, the
  exact CFI of a selection, saved highlights, showing a capture, the dark theme, the remembered
  place, book images and stylesheets, script files never running, and a fixed-layout book.
  Unit tests cover the streamer and the cleaning.
- Readium (about 360 KB) loads only when a book is opened.
- Updating Readium: rerun the WebKit check. The engine reads `_cframes` (Readium's frame
  managers) to reach the frames, which may change between versions.
