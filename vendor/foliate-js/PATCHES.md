# Local changes to foliate-js

Vendored from https://github.com/johnfactotum/foliate-js at the commit in `COMMIT` (MIT,
`LICENSE`).

Since decision 0045, EPUBs are read with Readium, and only **`epubcfi.js`** is kept: it makes
and resolves EPUB CFIs exactly as foliate-js did, so captures made with the earlier reader
keep resolving. Everything else was removed. `epubcfi.js` itself is unchanged.

Earlier changes (no longer present): the book iframes' sandbox (decisions 0024 and 0043), the
removed demo reader and PDF adapter, and the PDF branch in `view.js`.
