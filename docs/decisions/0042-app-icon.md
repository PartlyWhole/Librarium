# 0042. The app icon comes from the bold icon kit

- Status: accepted
- Date: 2026-10-04
- Request: R-025 in `docs/REQUESTS.md`

## Context and problem

The user supplied an icon kit, then a refined one, then a bold one (thicker strokes, the mark
re-centred), which is used; with five colourways and exports for the
web, desktop, Android and iOS. Librarium needs one app icon and a mark for its interface.

## Decision

- The app icon is the **Evergreen & gold** colourway, which the kit recommends for the app.
- The kit's desktop icon fills its whole canvas. macOS icons keep a transparent margin
  (824 px of artwork in 1024 px), so `assets/brand/app-icon-macos.svg` places it on that
  grid; `npx tauri icon` makes `src-tauri/icons/` from it.
- The kit is kept in `assets/brand/librarium-icon-kit/`, without Android and iOS (Librarium
  is a Mac app), so another colourway is a quick swap. `assets/brand/README.md` says how.
- The interface uses the currentColor master (`src/kit/logo.ts`) in the accent colour, so it
  follows light and dark mode.

## Consequences

- The development app shows the icon after a rebuild; a built app at the next `npm run build`.
- Changing colourway means regenerating `src-tauri/icons/`; the README's steps are short.
