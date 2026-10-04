# Plan: EPUBs read with Readium (R-029)

The user chose Readium (option C) for "first class experience of captures but also first class
reading/viewing experience". Status: in progress.

## Shape

```
EPUB bytes ──► streamer (src/reader/epub/streamer.ts)
                 unzip (fflate) · OPF → Readium manifest · positions
                 Fetcher: chapters cleaned (epub-safe) + resources as blob URLs
            ──► Publication (@readium/shared)
            ──► EpubNavigator (@readium/navigator): frames, Readium CSS, pages/scroll,
                 page turns across chapters, keyboard, preferences
            ──► engine (src/reader/epub.ts): the ReaderView contract, unchanged
                 selection → CFI (vendored epubcfi.js, same CFIs as before)
                 marks / find → CSS Custom Highlight API inside the frames
                 bottom bar: previous · contents · progress · Aa · next
```

## Decisions

- **No server streamer.** Readium expects a manifest and fetchable resources. The streamer
  builds the manifest from the OPF in the page and rewrites every resource reference (images,
  stylesheets, fonts, CSS `url()`) to a blob URL. Chapter links (`<a href>`) stay relative to a
  never-resolving base (`https://book.librarium.invalid/<id>/`); Readium turns clicks on them
  into navigation. Works the same in the app, the mock and the WebKit checks.
- **Security.** Readium needs scripts in frames (its own, as blob URLs). Book code is made
  inert before Readium sees a page: script elements are emptied and given an inert type (kept,
  so CFI paths don't shift); frames, plugins, `on…` handlers and `javascript:` links are
  removed; each page gets a policy `script-src blob:` (Readium's scripts are blob URLs; the
  book's script files are never served). Readium's own policy applies as well.
- **Captures unchanged.** Selections give the same CFI (spine-item CFIs from the OPF, as
  foliate made them) and text; showing a capture goes by its quote (Readium finds text);
  marks resolve CFIs to ranges in the frames and are drawn with `CSS.highlights`.
- **Reading settings** (per device, through the shell's prefs): size, font (book, serif,
  sans), spacing, line length, pages or scroll, theme (follow the app, light, sepia, dark).
  The place in each book is remembered.
- foliate-js goes, except `epubcfi.js`.

## Steps

1. Streamer + unit tests (manifest, TOC, cleaning, rewriting) on the fixture EPUB.
2. Engine on EpubNavigator; WebKit checks: opens, turns pages across chapters, contents,
   scripts never run, selection → CFI, marks drawn, find, settings.
3. Bottom bar and settings panel; remember the place.
4. Remove foliate-js; docs (decision 0045, DEVELOPING, REQUESTS).
