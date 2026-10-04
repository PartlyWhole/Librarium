# 0041. Web Crypto is hidden from pages being saved

- Status: accepted
- Date: 2026-10-04
- Request: R-022 in `docs/REQUESTS.md`

## Context and problem

While saving web pages, macOS sometimes asked the keychain for a "WebCrypto Master Key". A
page's script keeping a key through Web Crypto (`crypto.subtle`) makes WebKit protect it with
that master key. The incognito data store doesn't prevent it. The user denies these prompts.

The development app is re-signed on every rebuild, so the keychain asks again. An approach
that gave WebKit our own key through a private hook was refused for safety.

## Decision

- **A script runs in every frame of the saving window before the page's own scripts**
  (`initialization_script_for_all_frames`). It makes `crypto.subtle` read as missing and
  removes `SubtleCrypto`. `crypto.getRandomValues` stays.
- **No page can then make or keep a key, so WebKit has no reason to ask the keychain.**
  Nothing a page keeps in that window survives anyway (in-memory, wiped after each page).
- **It affects only the hidden saving window:** not the app's own window, the user's browser,
  their keychain or their library.
- A WebKit check (`page_probe suite`, fixture `crypto.html`) confirms the page sees no Web
  Crypto and still has random numbers.

## Consequences

- **A rare page that won't display without Web Crypto may save incomplete.** The page checks
  flag that on the snapshot (empty, incomplete), and it can be saved again.
- **The prompt's absence itself can only be confirmed in the real app,** by the user.
