# Librarium

A personal notebook and library for slow, careful intellectual work: read thinkers closely,
quote them exactly, and let your own ideas grow on top of what you read. One person, one Mac,
plain files in a folder you choose. See [`BRIEF.md`](BRIEF.md) for the full brief.

## Run it

Requirements: macOS 15+, Rust 1.77+, Node 20.11+, Apple's command-line tools.

```bash
npm install
npm run dev            # builds the worker, starts Vite and opens the app
```

| Command | What it does |
|---|---|
| `npm run dev` | Run the app in development |
| `npm run build` | Build an ad-hoc signed `Librarium.app` (with the worker bundled) in `target/release/bundle/macos/`; not notarized |
| `npm test` | All tests: Vitest, the WebKit reader checks, then `cargo test --workspace` |
| `npm run test:webkit` | End-to-end reader checks in WebKit (the app's engine) |
| `npm run lint` | ESLint, dependency-cruiser direction rules, clippy and rustfmt |
| `npm run gen:types` | Regenerate `src/generated/` from the `contracts` crate |
| `npm run dev:mock` | The interface alone in a browser, on a sample library (port 1421) |
| `npm run arch-report` | Print the architecture report (edges, API calls, slots, timings) |

## Layout

```
BRIEF.md                 the project's reference
CLAUDE.md                how AI sessions work here (requests, rules)
Cargo.toml               the Cargo workspace
crates/
  contracts/             types, IDs, events, errors, port traits, slots, API messages
  kernel/                writer, records, identity, changes, view and job hosts, registries, link parser
  api/                   the application API (plain Rust; tests drive it directly)
  adapters/              one crate per real adapter of a port
    fs-macos/ changes-fsevents/ index-sqlite/ versions-none/ pagesaver-webkit/
    transport-tauri/ worker-process/ system/
  features/              notes/ daily/ library/ captures/ search/ links/ archive/
  testkit/               test adapters for every port + the shared port suites
  worker/                the worker binary (parsers run here, never in the app)
src-tauri/               the app crate: the composition root
  tests/direction.rs     crate direction rules (cargo metadata) and the feature-name guard
  tests/arch_report.rs   the architecture report
src/                     the interface (plain TypeScript + Vite)
  generated/             ts-rs types; never edited by hand
  backend.ts             the only file that talks to the Transport
  shell/ kit/ editor/ reader/ features/
tests/                   interface-wide tests, the WebKit check page, and fixtures
vendor/foliate-js/       only its EPUB CFI module, pinned (see PATCHES.md; books use Readium)
assets/brand/            the icon kit and the app icon's source (see its README)
docs/decisions/          MADR-style decision records
docs/REQUESTS.md         feature and change requests: you write them, the AI answers them there
docs/DEVELOPING.md       the developer guide: architecture, subsystems, lessons learned
docs/plans/              plans for work in progress
```

Dependencies point inward, towards `contracts`. Rust: `src-tauri/tests/direction.rs`.
Interface: `.dependency-cruiser.cjs`, run by `npm run lint:deps` and `tests/direction.test.ts`.

## Decisions

| Date | Decision | Record |
|---|---|---|
| 2026-10-02 | All decisions in `BRIEF.md` (§3–§7, §11), made with the user before the project began. | [BRIEF.md](BRIEF.md) |
| 2026-10-02 | SQLite through `rusqlite` with the bundled SQLite (FTS5 guaranteed, synchronous). | [0001](docs/decisions/0001-sqlite-crate.md) |
| 2026-10-02 | Frontmatter read with `saphyr-parser`, written by our own byte-span editor. | [0002](docs/decisions/0002-yaml-crate.md) |
| 2026-10-02 | TypeScript types generated from an explicit export list; a test checks they are current. | [0003](docs/decisions/0003-type-generation.md) |
| 2026-10-02 | Test adapters and shared port suites live in `crates/testkit`. | [0004](docs/decisions/0004-test-adapters.md) |
| 2026-10-02 | A `WorkerHost` port and an `adapters/system` crate for Clock and IdGenerator. | [0005](docs/decisions/0005-ports-beyond-the-table.md) |
| 2026-10-02 | The worker is bundled with `externalBin` only when packaging. | [0006](docs/decisions/0006-packaging-the-worker.md) |
| 2026-10-02 | TypeScript held at 6.0 until typescript-eslint supports 7. | — |
| 2026-10-02 | The test file system models APFS: renames commit as one transaction. | [0007](docs/decisions/0007-durability-model.md) |
| 2026-10-02 | A full startup check after an unclean shutdown (the lock file was left behind). | [0008](docs/decisions/0008-full-check-after-unclean-shutdown.md) |
| 2026-10-02 | How two files with one ID are classified, and when IDs are rewritten. | [0009](docs/decisions/0009-duplicate-ids.md) |
| 2026-10-02 | API calls about the user's folder are `folder.*`; the name guard checks strings and feature crates. | [0010](docs/decisions/0010-folder-vocabulary.md) |
| 2026-10-02 | A record's path is the truth for its folder; renames and moves are intents. | [0011](docs/decisions/0011-folders-and-renames.md) |
| 2026-10-02 | A `Desktop` port shows things in Finder (reveal logs, the library folder). | [0012](docs/decisions/0012-desktop-port.md) |
| 2026-10-02 | Interface tests and the browser preview use an in-process mock backend; interface errors go to the log. | [0013](docs/decisions/0013-interface-test-backend.md) |
| 2026-10-02 | The sidebar tree is virtualized (10,000 notes). | [0014](docs/decisions/0014-virtualized-tree.md) |
| 2026-10-02 | A read-only or locked file is never replaced; saves to it are retried and reported. | [0015](docs/decisions/0015-read-only-files.md) |
| 2026-10-02 | Features offer API calls through the `kernel.api-methods` slot. | [0016](docs/decisions/0016-feature-api-calls.md) |
| 2026-10-02 | How notes are edited, saved, recovered and merged; undo for renames and moves. | [0017](docs/decisions/0017-editing-and-conflicts.md) |
| 2026-10-02 | The derived-view host keeps views in step by record hashes; one file per view. | [0018](docs/decisions/0018-derived-view-host.md) |
| 2026-10-02 | The job host: persistent jobs, idempotency keys, triggers, one retry after a worker failure. | [0019](docs/decisions/0019-job-host.md) |
| 2026-10-02 | When link labels are refreshed and missing IDs restored. | [0020](docs/decisions/0020-link-repair.md) |
| 2026-10-02 | Feature API message types live in `contracts`. | [0021](docs/decisions/0021-feature-api-types.md) |
| 2026-10-03 | How files are imported: staging, one rename, text extracted in the worker. | [0022](docs/decisions/0022-imports.md) |
| 2026-10-03 | The reader uses PDF.js's legacy build and a polyfill; end-to-end checks run in WebKit. | [0023](docs/decisions/0023-reader-and-webkit.md) |
| 2026-10-03 | foliate-js vendored at a pinned commit, with book scripts disabled. | [0024](docs/decisions/0024-foliate-js.md) |
| 2026-10-03 | How captures anchor, and how places are found again (found, moved, lost). | [0025](docs/decisions/0025-anchors.md) |
| 2026-10-03 | Captures meets the reader and editor through reader tools, places and embeds. | [0026](docs/decisions/0026-feature-meeting-points.md) |
| 2026-10-03 | How web pages are saved: a hidden WebKit window, createPDF, page checks, snapshots. | [0027](docs/decisions/0027-saving-web-pages.md) |
| 2026-10-03 | Text recognition with Apple Vision in the worker, stored and selectable. | [0028](docs/decisions/0028-text-recognition.md) |
| 2026-10-03 | Archive sets a field; permanent deletion needs an archived record and a single-use confirmation token. | [0029](docs/decisions/0029-archive-and-permanent-deletion.md) |
| 2026-10-03 | The real-pages check, on 10 pages from the user's list: PDFKit for PDF text, in-memory page saving, soft hyphens, canvas and slow-page checks, fewer false alarms. | [0030](docs/decisions/0030-real-pages-check.md) |
| 2026-10-03 | Making captures: a button by the selection, a panel beside the document, parts highlighted and in source order, sharp regions. | [0031](docs/decisions/0031-making-captures.md) |
| 2026-10-03 | Removing snapshots (two steps; never the last, never one a capture uses) and selecting several records. | [0032](docs/decisions/0032-removing-snapshots-and-selecting-several.md) |
| 2026-10-03 | Folders: real subfolders, notes and library items each with their own; their pages browse them as in Finder; captures under their items; pointer dragging; arranging by hand. | [0033](docs/decisions/0033-folders-and-the-files-page.md) |
| 2026-10-03 | Tabs, as in Obsidian: each with its own history and living page; ⌘T, ⌘W, ⇧⌘T, ⌃Tab, ⌘1–9; Today moves to ⇧⌘D. | [0034](docs/decisions/0034-tabs.md) |
| 2026-10-03 | Daily notes are ordinary notes at the top level of Notes; Today (ribbon, ⇧⌘D) opens or makes today's; no special group. | [0035](docs/decisions/0035-daily-notes-are-notes.md) |
| 2026-10-03 | Links to the web ask first (where they go, a warning if misleading) and open in the browser; the window never leaves the app. | [0036](docs/decisions/0036-links-to-the-web.md) |
| 2026-10-03 | First-class writing: live preview per construct, formatting keys and a Format menu, multiple cursors, list moves, HTML pasted as Markdown, folding, code highlighting, counts, outline; aliases survive renames (amends 0020). | [0037](docs/decisions/0037-first-class-writing.md) |
| 2026-10-03 | Version history in `.librarium/history` (content-addressed objects, one log per Mac), spaced versions, outside edits, staggered retention, restore with undo, deleted notes brought back; permanent deletion erases it. | [0038](docs/decisions/0038-version-history.md) |
| 2026-10-03 | The side panel shows one view at a time (icons along its top: Links, Outline, History, Captures, About, Jobs); repeated jobs are grouped. | [0039](docs/decisions/0039-side-panel-one-view.md) |
| 2026-10-03 | Images in notes are library items: pasted or dropped, imported, embedded as `![[title|id]]`, shown in place. | [0040](docs/decisions/0040-images-in-notes.md) |
| 2026-10-04 | Web Crypto is hidden from pages being saved, so WebKit never asks the keychain. | [0041](docs/decisions/0041-no-web-crypto-when-saving.md) |
| 2026-10-04 | The app icon is the bold kit's Evergreen & gold, padded to macOS's icon grid. | [0042](docs/decisions/0042-app-icon.md) |
| 2026-10-04 | Book frames allow scripts (WebKit runs no listeners otherwise); book scripts are stopped by cleaning, a policy, and never loading script files. | [0043](docs/decisions/0043-epub-frames-allow-scripts.md) |
| 2026-10-04 | A PDF's selectable text lies exactly over the page (no border) and is placed word by word with the font's widths. | [0044](docs/decisions/0044-pdf-text-placement.md) |
| 2026-10-04 | EPUBs are read with Readium, served from memory (no server); captures keep their CFIs; reading settings and places per device. | [0045](docs/decisions/0045-epub-readium.md) |
| 2026-10-04 | Books read like Apple Books: immersive toolbar, running head, pages left in chapter, edge arrows and swipes, a Books-style Aa panel. | [0046](docs/decisions/0046-books-style-reading.md) |
