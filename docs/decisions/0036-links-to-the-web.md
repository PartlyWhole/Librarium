# 0036. Links to the web ask first, and open in the browser

- Status: accepted
- Date: 2026-10-03

## Context and problem

A link in a saved page took the whole window to the website, full screen, with no clear way
back to Librarium.

## Decision

- **The window never leaves the app.** A Tauri plugin's navigation handler stops any
  navigation of the main window to an address that isn't the app's own: the bundled app, the
  dev server, `about:`, `data:`, `blob:` or `asset:`. The page saver's hidden window is
  exempt, since it has to load pages. A stopped web or mail address is sent to the interface
  as `event.openLink`.
- **The interface asks first.** A capture-phase click handler catches links to the web
  anywhere in the window: saved pages and PDFs (PDF.js link annotations are anchors), notes
  and side panels. A book's pages report theirs through foliate's `external-link`.
- **The dialog says:**
  - the link's words and where it goes (the site);
  - the full address, which can be selected;
  - which page it was clicked on;
  - a warning when the words name another site than the one it goes to, or when it isn't
    secure (http).
  - **Buttons:** Cancel, Copy link, and Open in browser (or Open in Mail).
- **Opening goes through the backend** (`app.openUrl` and the Desktop port's `open_url`). It
  accepts only `http`, `https` and `mailto` addresses without spaces or control characters,
  and passes them to `/usr/bin/open` after `--`, so an address can never be read as an option.

## Consequences

- A link inside a saved page can't be followed inside the app. That is on purpose: the
  library keeps snapshots, and the web is the browser's.
