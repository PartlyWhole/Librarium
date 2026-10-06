# 0067. Boards: keys, VoiceOver, speed

- Status: accepted
- Date: 2026-10-05
- Request: R-057 (boards, phase 6 of `docs/plans/boards.md`)

## Context and problem

The last phase of boards checks them against the brief's standing rules:
- every action reachable by keys;
- VoiceOver reads the controls and an axe check passes (§8, milestone 2);
- start-up and speed budgets hold;
- the architecture report is current (§4.5).

## Decision

- **Keys.** On a board's canvas only the app's reserved shortcuts win (0063). Of Excalidraw
  0.18.1's ⌘ and ⌥ shortcuts, those taken are exactly:
  - ⌘/ (the app's shortcuts list), ⇧⌘P (the palette) and ⌘O (Open; Excalidraw's own is off);
  - ⇧⌘[ / ⇧⌘] (switch tabs). Excalidraw's ⌥⌘[ / ⌥⌘] still bring forward and send back;
  - ⌘Z / ⇧⌘Z, sent on to Excalidraw.

  None of its single-key tools is the app's. A test lists Excalidraw's shortcuts and fails if
  a new reserved shortcut takes another; it is re-listed when Excalidraw is upgraded. The
  board's own commands use ⌥⌘: N (new), K (link to…), I (put on the board…).
- **VoiceOver.**
  - The canvas is a named region ("Drawing: <title>", following renames).
  - Beside it, a list VoiceOver reads says what is on the board: its texts, and its links,
    cards and pictures by name, in reading order (`boardOutline`), kept current as the board
    changes.
  - Each card is a named group ("Capture: …").
  - The board page passes the axe check.
- **Speed.** A board of 380 elements (300 shapes, 40 texts, 30 cards, 10 pictures):
  - opens in 20 ms once the engine is loaded;
  - is read for saving in 1 ms;
  - is drawn as a picture in 58 ms.

  A WebKit check holds these to under 1 s, 100 ms and 3 s. Cards out of view aren't drawn
  until scrolled to. The engine stays out of the start-up bundle (`board-engine-loads-on-demand`).
- **Architecture report.** It now starts the app with every feature, as `main.ts` does, and
  lists embeds, record looks and the archiver slot. Captures gained a record look ("Capture",
  a quote icon), so pickers and cards name them properly.

## Consequences

- Excalidraw's canvas itself isn't readable by VoiceOver; the outline and the readable page
  carry its words.
- Upgrading Excalidraw means re-listing its shortcuts (`EXCALIDRAW_KEYS` in
  `tests/boards.test.ts`), re-running the probe and checking the CDN rewrite (0061).
