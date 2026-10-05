# 0061. React and Excalidraw for boards only, loaded on demand, offline

- Status: accepted (the user chose it on 2026-10-05, R-057); an exception to brief §3 ("no UI
  framework") for one feature
- Date: 2026-10-05

## Context and problem

Boards (`docs/plans/boards.md`) reuse Excalidraw for the whiteboard. Excalidraw exists only as a
React component. The brief's interface is plain TypeScript with no UI framework. The reasons
are not written down; read from the brief, they are speed (start-up and keystroke budgets),
longevity, simplicity, and that the big parts (CodeMirror, PDF.js, Readium) need none.

## Options considered

- React only inside the boards feature, loaded when a board opens (chosen).
- Excalidraw in its own frame, talking to the app by messages: better isolated, but cards,
  links, keys, focus and undo all cross a frame boundary.
- No Excalidraw: a smaller whiteboard built on rough.js and perfect-freehand, far fewer tools,
  months of work.

## Decision

- `react` 19.3.0, `react-dom` 19.3.0 and `@excalidraw/excalidraw` 0.18.1 are pinned exactly.
- Only `src/features/boards/` may import them: dependency-cruiser rule
  `react-only-in-boards`, checked by the direction test with a fixture that breaks it.
- They load on demand, when a board opens, so start-up and the rest of the app are unchanged.
- **Offline.** Excalidraw's fonts are copied into `public/excalidraw/fonts` (the assets step,
  `scripts/copy-pdfjs.mjs`) and served by the app. Excalidraw also lists a public CDN (esm.sh)
  as a second source for every font; a small Vite transform (`vite.config.ts`, applied to
  builds and to the dev server's pre-bundle) points that source at the same local folder. The
  app's security policy blocks the network anyway (`connect-src`), so nothing missed can leak.
- **Patched nested packages.** npm `overrides` pin patched versions of nanoid, sass and
  lodash-es inside Excalidraw's dependencies. `npm audit` reports 0 vulnerabilities.

## Consequences

- Phase 0 of the plan, run in WebKit with the app's security policy, passed:
  - first open in a production build: 219 ms, then 109 ms;
  - no network requests and no policy violations;
  - a card built with plain DOM (as the app's embeds are) shows inside an Excalidraw embed
    element;
  - ⌘Z undoes one step, and redo works;
  - the dark theme applies;
  - the drawing saves and reloads with its links;
  - SVG export works;
  - typing `[[` in Excalidraw's text editor can be seen by the app.
- Bundle: about 7.9 MB of JavaScript in all, mostly Excalidraw's text-to-diagram feature, which
  loads only if used. Fonts: 13 MB, 12 MB of it Chinese and Japanese, loaded only for those
  characters.
- Upgrading Excalidraw is a deliberate step: re-run the probe (`target/probe/board.ts`) and
  check the CDN rewrite still matches.
