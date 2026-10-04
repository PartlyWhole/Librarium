# 0024. foliate-js is vendored at a pinned commit, with book scripts disabled

> Superseded by 0045: EPUBs are read with Readium; only foliate-js's `epubcfi.js` is kept.

- Status: accepted
- Date: 2026-10-02

## Context and problem

§3 says to vendor foliate-js at a pinned commit (its API is not stable). §4.3 says webviews
showing EPUBs get no IPC. Upstream sandboxes book iframes with both `allow-same-origin` and
`allow-scripts`, which together let a book's script reach the app's window.

## Decision

`vendor/foliate-js/` holds commit `78914aef4466eb960965702401634c2cb348e9b1` (MIT), trimmed
to what Librarium uses. Book iframes are sandboxed with `allow-same-origin` only, so a book's
scripts never run (checked by the WebKit test). The changes are listed in
`vendor/foliate-js/PATCHES.md`.

## Consequences

Updating foliate-js means re-applying `PATCHES.md` and rerunning the WebKit check.
