# Local changes to foliate-js

Vendored from https://github.com/johnfactotum/foliate-js at the commit in `COMMIT` (MIT).

1. (Undone, decision 0043.) Book iframes were sandboxed with `allow-same-origin` only, but WebKit
   then runs no event listeners in them at all (WebKit bug 218086), so selection, keys and
   scrolling inside a book never reached the app. They are back to upstream's
   `allow-same-origin allow-scripts`; the book's scripts are stopped as upstream's README
   requires, by Librarium (`src/reader/epub-safe.ts`): code removed from every page, a
   Content Security Policy forbidding scripts in every page, and script files never loaded.
2. Removed what Librarium doesn't use: the demo reader (`reader.*`, `ui/`), tests, build
   tooling, the PDF adapter (`pdf.js`) and its bundled PDF.js (Librarium uses its own).
3. `view.js`: the PDF branch throws "not supported" instead of importing the removed adapter.
