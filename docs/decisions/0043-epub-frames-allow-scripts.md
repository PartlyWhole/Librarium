# 0043. Book frames allow scripts; the book's scripts are stopped by cleaning and a policy

- Status: accepted (replaces the no-scripts sandbox in foliate-js PATCHES.md item 1)
- Date: 2026-10-04
- Request: R-026 in `docs/REQUESTS.md`

## Context and problem

EPUBs showed only their first chapter. Foliate shows one chapter at a time when scrolling;
moving on needs keys, the wheel or buttons, and the app had none. Adding them showed a deeper
problem. Book pages were in iframes sandboxed without `allow-scripts`, and WebKit (the app's
engine) then runs **no** event listeners in them, not even the app's
(https://bugs.webkit.org/show_bug.cgi?id=218086). Keys, the wheel and the mouse-up that starts a
capture from a selection never reached the app. Upstream foliate-js uses `allow-scripts` for
this reason, and its README requires a Content Security Policy to block the book's scripts.

## Decision

- Book iframes are back to upstream's `allow-same-origin allow-scripts`.
- The book's code never runs, by three independent means (`src/reader/epub-safe.ts`, wired in
  `src/reader/epub.ts`):
  1. Script files in the book are never loaded (foliate's `load` hook).
  2. Every page is cleaned before it becomes a blob URL: scripts, frames, plugins, `<base>`,
     `<meta http-equiv>`, `on…` handlers and `javascript:` links are removed.
  3. Every page gets a Content Security Policy that forbids scripts, plugins, frames,
     workers, `<base>` and form submission.
- Reading on: scrolling on past a chapter's end (or start) after a pause turns the chapter, so
  a trackpad's momentum doesn't. Space and Page Down/Up move by a screen and on into the next
  chapter; ← and → turn chapters. A bar holds previous, contents and next.

## Consequences

- A book's frame shares the app's origin, so a script that slipped past all three means could
  reach the app. The WebKit check proves that inline scripts, event handlers and `javascript:`
  links don't run, and that every page carries the policy. Unit tests cover the cleaning.
- Selection, keys and the wheel inside books now reach the app.
