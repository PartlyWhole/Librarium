# Plan: Boards: a note you can draw on (Excalidraw)

Request R-057:
> "Please plan an excalidraw page "feature" that supports putting in captures and [[]] links,
> etc. Basically a note but can draw/write on it like a whiteboard. This is going to be a big
> feature because there are a lot of tools already with excalidraw. Please plan carefully"

Status: **planned; three decisions wait for the user** (below). Nothing is built yet.

In this plan, *fact* means checked (against the code, the brief or the Excalidraw package
0.18.1, unpacked and read). *Proposal* means my recommendation. *Assumption* means not yet
checked; each one is checked in phase 0.

---

## 1. What it is

A **board** is a record that is a whiteboard: Excalidraw's canvas and tools (shapes, arrows,
freehand, text, frames, images, the laser pointer) inside Librarium. Things from the library
can be put on it as first-class objects:

- **Links** to any record: `[[` in a text, or "Link to…" on any shape. Clicking one opens the
  record. A link survives renames and moves (it points at the ID), and shows in the target's
  backlinks.
- **Captures** as live cards: the quotation and its citation, as embeds show them in notes.
  "Show in the source" opens the place; editing the capture updates the card.
- **Library items and notes** as cards: title and icon; a click opens them.
- **Images** pasted or dropped: kept in the Library's Attachments folder, as images in notes
  are (R-042).

A board sits with notes in the sidebar, is found by search, appears in backlinks, can be
renamed, moved, archived and undone like any record, and can be embedded in a note as a
picture.

## 2. Decisions the user must make (asked, not guessed)

### D1. Excalidraw needs React; the brief says "no UI framework" (§3, decided)

*Fact:* `@excalidraw/excalidraw` 0.18.1 (released 2026-10-01) is a React component (peer
dependency React 17–19). There is no non-React build.

- **A (recommended): Excalidraw with React, kept inside the boards feature.** React is
  imported only by `src/features/boards/` (a dependency-cruiser rule enforces it). It loads
  only when a board is opened (as the EPUB reader does), so the rest of the app and its
  startup are unchanged. Cost: about 2.8 MB of JavaScript, 145 KB CSS and React (about
  140 KB), all loaded only on first open.
- **B: Excalidraw in its own frame.** React lives in a separate page inside a frame and talks
  to the app by messages. It's better isolated, but capture cards and links must be passed
  across by messages, every interaction is slower to build, and focus, keys and undo cross a
  frame boundary. It costs more for little gain, since A already confines React.
- **C: no Excalidraw.** Build a whiteboard from Excalidraw's own framework-free parts
  (rough.js, perfect-freehand). This keeps §3 intact, but rebuilds selection, text editing,
  arrows that bind, frames, export, history… — months of work, and nowhere near "a lot of
  tools already".

### D2. Where boards live, and what kind they are

*Fact:* each top folder holds one kind, and the sidebar and Files pages show one kind per
section (notes in `notes/`, items in `items/`).

- **A (recommended): a new kind, `board`, kept in the Notes folders.** Boards sit beside
  notes in the same folders (`notes/Thinkers/…`), with their own icon. This needs a small
  kernel change: a folder space may hold several kinds (notes and boards) that share its
  folders and arrangement.
- **B: a new kind with its own top folder and sidebar section** (`boards/`, "Boards"). It
  needs no kernel change, but boards are kept apart from the notes they belong with.
- **C: a note with a drawing** (kind `note` plus a field). Boards are free in the Notes
  folders, but a "note" whose text is generated is a trap: text written in its body (in the
  app or Obsidian) would be overwritten.

### D3. The file format (§10: "don't guess on data formats")

- **A (recommended): a Markdown record plus a plain Excalidraw file beside it.**
  - `notes/<id>-<slug>.md`: frontmatter (`kind: "board"`) and a readable body generated from
    the board. The body holds its texts, in reading order, and its links (`[[label|id]]`)
    and captures (`![[label|id]]`), so search, backlinks, "used by" and Obsidian all see
    them.
  - `notes/<id>.excalidraw`: the drawing, in Excalidraw's own open JSON format. It opens at
    excalidraw.com and in Excalidraw's apps, and is readable as text.
  - This follows the brief ("structured data lives in JSON files paired with the record by
    ID", §5.3). *Fact:* the kernel already writes `<id>.<suffix>` sidecars and moves them
    with the record. The body says at its top that the app writes it, so edits to it are
    replaced on the next save.
- **B: one file in Obsidian Excalidraw's format** (`.excalidraw.md`, the drawing inside the
  Markdown, compressed). It opens in Obsidian's Excalidraw plugin, but the drawing is
  compressed text that can't be read without tools, and it ties our format to a plugin's.
  *Assumption, to check:* that plugin's exact layout.
- **C: one Markdown file with the drawing as a plain JSON block.** Everything is in one
  file, but a large board makes a very long note in any other editor.

Images (D3-A): Excalidraw keeps images inside its file as data. Instead, each image is a
library attachment, and the board's file refers to it by record ID. **Export as
Excalidraw…** writes a self-contained copy with the images inside.

## 3. Shape (with A, A, A)

```
notes/Thinkers/<id>-ellul-map.md          kind: board; generated readable body (texts, links, embeds)
notes/Thinkers/<id>.excalidraw            the drawing (Excalidraw JSON), images by record ID

Rust  crates/features/boards              kind def; boards.create / boards.load / boards.save
                                          (drawing + body in one write, version-checked)
      kernel                              several kinds in one folder space; save with sidecar
TS    src/features/boards/index.ts        kind look, opener, New board, folder space, embeds
      src/features/boards/page.ts         the board page: load, autosave, drafts, conflicts
      src/features/boards/engine.tsx      (lazy) React + Excalidraw: props, theme, keys,
                                          embeddables → our DOM, links, images
      src/features/boards/mirror.ts       drawing → readable body (pure; unit tested)
```

## 4. How each part works (proposals)

### Saving and safety (the brief's "no write is lost")

- **Autosave** about 1 s after the last change, and at once on blur, on closing the tab and
  on quitting (`beforeClose`). The same rules as notes.
- **One write per save:** the drawing and its readable body are written together, checked
  against the version they were based on. New kernel call: save a body and a sidecar
  together with a version check. Today's `write_sidecar` has no check.
- **Drafts:** the unsaved drawing is kept in Application Support's `drafts/`, as for notes.
  After a crash, it's offered on reopening.
- **Outside changes** (the `.excalidraw` edited elsewhere, or synced):
  - with no unsaved change, the board reloads;
  - with both changed, the app never merges silently (decision 0017). It keeps its own, saves
    the outside version as a copy board next to it, and says so.
  - *Assumption, to check:* that the change watcher reports sidecar edits.
- **Version history** (0038) covers the drawing as well as the body.

### Excalidraw, offline and calm

- **Fonts are served locally** (`EXCALIDRAW_ASSET_PATH`). *Fact:* the package ships them,
  1 MB plus 12 MB of Chinese/Japanese hand-drawn font loaded only for those characters.
- **Online features off:**
  - *Fact:* the package contains addresses for share links, live collaboration, the AI
    "text to diagram", the online shapes gallery and Twitter/YouTube embeds.
  - AI is off (`aiEnabled: false`); collaboration isn't started; link sharing and the online
    gallery are hidden. Embeds accept only Librarium's own records (`validateEmbeddable`).
  - *Fact:* the app's security policy already blocks network access (`connect-src` is only
    the app itself), so anything missed fails quietly.
- **Matches the app:** the light/dark theme, the app's font for the UI, and no Excalidraw
  welcome screen or branding. Saving and opening go through Librarium: Excalidraw's own
  "Save to file", "Open" and "Export" are replaced by ours.
- **Keys:**
  - the app's shortcuts are checked against Excalidraw's single-letter tools (V, R, D, O, A,
    L, P, T, E, H…). The app's keys use ⌘, so few collide.
  - while the canvas has focus, only the app's reserved keys (tabs, palette, go to) win.
  - ⌘Z / ⇧⌘Z: Edit ▸ Undo and Redo (0054) gain a third target, the board. *Fact:*
    Excalidraw has no undo call, so the menu sends it the key itself. *To check in the real
    app:* that the menu's ⌘Z reaches it once, not twice.
- **Undo history:** Excalidraw's own, per board while it's open. Moving or archiving the board
  goes through the app's undo (0055), as for any record.

### Links

- **`[[` in a text element** opens the usual title picker. Picking puts the label in the text
  and links the element to the record. The text keeps `[[label|id]]` in the element's
  `customData`, and the canvas shows only the label, as the editor does.
  - Excalidraw links a whole element, not words inside it. A text with several links shows
    all labels, but a click opens the first. The others are listed in the side panel's
    Links view and in the readable body.
- **"Link to…"** on any shape or selection (menu, ⌘K) links it to a record.
- **Clicking a link** opens the record (`onLinkOpen`); with ⌘, in a new tab.
- **Backlinks:** links are written into the readable body as `[[label|id]]`, so the kernel's
  one parser finds them. Renames refresh labels by ID; the drawing keeps the ID.

### Captures, items and notes on the board

- **Putting one on the board:**
  - drag it from the sidebar, the side panel's Captures view, the Captures page or search
    results;
  - or use "Insert capture…" / "Insert link…" (a picker).
- **A capture becomes an Excalidraw embed element** whose link is the capture's ID. Our own
  renderer draws it with the same code that draws embeds in notes: the quotation (parts
  joined by […], R-055), the citation, Show in the source, and the pencil to edit. It
  resizes and moves like any shape, and stays current when the capture changes.
- **A library item or note** becomes a card: icon, title and kind. A click opens it.
- **In the readable body** captures are written `![[label|id]]`, so "used by", export with
  quotations and backlinks include boards.
- **Images** pasted or dropped become attachments (Library ▸ Attachments). The drawing
  refers to them by ID and loads them when it opens.

### Boards elsewhere in the app

- **New board** (File menu, palette, folder menus and the sidebar's New… menu). It opens
  ready to draw.
- **In a note,** `![[Board|id]]` shows the board as a picture (an SVG drawn from its file),
  refreshed when the board changes. A click opens it.
- **Export:** PNG, SVG, or a self-contained `.excalidraw`, through the native save dialog.
- **Records:** rename, move, folders, archive, delete permanently, the Undo history, search
  (its texts), backlinks (both ways) and version history all behave as for notes.

## 5. Phases (each ends with tests passing, a working app, a commit and a note to the user)

| # | Phase | Done when |
|---|---|---|
| 0 | **Spike** (decides go / no-go), in the WebKit runner on a probe page | Excalidraw draws with React in the app's WebKit, offline with local fonts and under the app's security policy. A capture card (our DOM in an embed element) renders and resizes. ⌘Z from the menu undoes once. Theme switches. First open takes under 500 ms on this Mac, with size and memory measured. Every assumption above is checked or replaced. |
| 1 | **Kind and storage** (Rust) | `board` kind (per D2) and its folder space; `boards.create/load/save` with drawing and body in one version-checked write; sidecar moves on rename, folder moves, archive and permanent delete; unknown fields kept; a newer `kind-version` opens read-only. Crash tests: a save interrupted at each step leaves either the old pair or the new pair. |
| 2 | **The board page** | Opens, draws, autosaves; reopening shows it as left. A `kill -9` within a second of drawing loses nothing (draft). Outside edits reload; both-changed keeps a copy and says so. Edit ▸ Undo/Redo work. No network request is made (checked). Theme follows the app. |
| 3 | **Links** | `[[` picker in text elements; Link to…; clicks open records; links show in the target's backlinks and survive a rename of the target; the readable body is correct (unit tests on the conversion). |
| 4 | **Captures, items, images** | Drag or insert a capture: a live card that updates when the capture is edited, with Show in the source; items and notes as cards; pasted images become attachments and reload from the library; "used by" lists the board. |
| 5 | **Boards elsewhere** | New board from the menus; a board embedded in a note shows as a picture; export PNG/SVG/.excalidraw; search finds its texts. |
| 6 | **Polish** | Keys audited; VoiceOver reads the page's controls, and the readable body serves as the board's text; decision records, README table, DEVELOPING and arch-report updated; budgets measured. |

Tests:
- **Rust:** kind, saves, sidecars, crash cases.
- **Vitest:** the readable body conversion, the page with a fake engine, links and cards.
- **WebKit runner:** the real Excalidraw: draw, save, reload, card, link click, undo, theme, no
  network.
- **Real app only:** the native menu's ⌘Z, and drag and drop from Finder.

## 6. Risks

- **Bundle and memory.** Excalidraw is large; measured in phase 0. It loads only on boards.
- **Upstream churn.** Excalidraw changes often; version 0.18.1 is pinned and upgrades are
  deliberate. The drawing is stored in Excalidraw's documented file format, which its
  `restore` reads across versions.
- **Keys and focus.** Excalidraw listens to the keyboard. The app's handler must leave the
  canvas alone, except for reserved keys.
- **Accessibility.** A canvas isn't readable by VoiceOver. The board's text is still
  available, in the readable body and the side panel.
- **The readable body drifts from the drawing** if edited outside. It's documented as
  written by the app and regenerated on each save; it is never read back.
- **Large boards** (hundreds of images): images load lazily from the library; measured in
  phase 4.

## 7. Not in this plan

- Live collaboration and sharing.
- Excalidraw's online shapes gallery and AI tools.
- Links to a single element inside a board (`[[Board#element]]`): possible later.
- Editing the board from Obsidian.
- Handwriting recognition.
