# 0027. How web pages are saved

- Status: accepted
- Date: 2026-10-03

## Context and problem

§3–§4: save a web page from its address as a faithful PDF plus clean text, through WebKit in
the app's webview (`WKWebView.createPDF`), with page checks and snapshots.

## Decision

- **The PageSaver adapter** (`adapters/pagesaver-webkit`) opens the page in a hidden window of
  the app. Only the main window has command permissions, so the page gets no IPC. It waits for
  the load, then runs a script in an isolated JavaScript world (`WKContentWorld`) that
  scrolls through the page (so lazy images load), waits for images, and reads the clean text
  (the article or main content), all visible text, metadata (author, site, published date,
  language), the HTTP status, a count of visible images, and the page's size.
- **The PDF:** `createPDF` with a rectangle covering the whole page (without one it captures
  only the visible part). Pages taller than 14,000 px are captured in slices of 10,000 px,
  joined into one PDF with PDFKit.
- **Page checks** (`library::checks`) classify a saved page as an error, not found, paywall,
  human verification, sign-in wall or empty, from its status, title, text and HTML.
  Tested on stored fixture pages. A snapshot is always kept; its checks are stored with it and
  shown in the reader, so the user decides.
- **Snapshots:** saving an address again (or one that redirected to it) adds
  `snapshots/<time>/page.pdf` and `text.json` to the same item, and appends to
  `library.snapshots` (time, sha256 of the PDF, final address, status, checks).
  `record.json` keeps the provenance: source address, final address, author, publication,
  published date, saved-at and saved-with. Text sources take an optional part, so
  `records.text {id, part}` gives a snapshot's own text. Captures record their snapshot, and
  are anchored and shown in it.
- **The job** (`library.savePage`) is resumable, keyed by the address, and idempotent: a
  snapshot whose PDF matches an existing one isn't added twice.
- `page_probe` (an example binary) runs the real adapter: `suite` on locally served fixture
  pages (part of the tests), and `check <worker> <url>…` reports, for real pages, how much of
  the visible text and how many of the images appear in the PDF.

## Consequences

The real-pages check (§8: "checked on a list of 10 real pages the user approves") runs with
`page_probe check` once the user has approved a list.
