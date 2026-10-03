# Local changes to foliate-js

Vendored from https://github.com/johnfactotum/foliate-js at the commit in `COMMIT` (MIT).

1. `paginator.js`, `fixed-layout.js`: book iframes are sandboxed with `allow-same-origin` only
   (upstream also allows scripts). A book's own scripts never run, so they can't reach the
   app's window or its IPC (BRIEF §4.3: webviews showing EPUBs get no IPC).
2. Removed what Librarium doesn't use: the demo reader (`reader.*`, `ui/`), tests, build
   tooling, the PDF adapter (`pdf.js`) and its bundled PDF.js (Librarium uses its own).
3. `view.js`: the PDF branch throws "not supported" instead of importing the removed adapter.
