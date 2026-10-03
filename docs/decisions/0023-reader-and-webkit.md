# 0023. The reader: PDF.js's legacy build, a polyfill, and end-to-end checks in WebKit

- Status: accepted
- Date: 2026-10-02

## Context and problem

The reader must render JBIG2 and JPEG 2000 scans completely, open the first page of a
100-page PDF in under 500 ms, and zoom and find in every format. Tauri has no WebDriver on
macOS, and Chromium (the browser preview) is not the app's engine.

## Decision

- **An end-to-end check in WebKit:** `npm run test:webkit` starts Vite, loads
  `tests/webkit/reader-check.html` in an offscreen-sized, nearly transparent `WKWebView`
  (`scripts/webkit-run.swift`; animation frames pause in hidden windows), and checks the
  results. It renders each scan to a canvas with and without the wasm files and counts the
  pixels drawn, times the first page, and exercises zoom and find in every engine.
- It found two bugs that would have broken every PDF in the app on macOS 15. So we use PDF.js's
  **legacy build** (the modern one needs `Map.prototype.getOrInsertComputed`), and a small
  polyfill for async iteration of `ReadableStream`, which PDF.js uses to read text.
- PDF.js's worker, wasm decoders, cmaps, standard fonts and ICC profiles are copied to
  `public/pdfjs/` at build time and served by the app (`wasmUrl` set); the CSP allows
  `connect-src 'self'` for them.
- Engines fill the `shell.reader-engines` slot: PDF (PDF.js viewer components), EPUB
  (foliate-js), image. File bytes reach the reader through a `bytes` command returning an
  `ipc::Response`, limited to the item's own folder.

## Consequences

The WebKit check is part of `npm test`. It needs Swift (part of the command-line tools).
