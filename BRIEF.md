
# Librarium — build brief

You are building **Librarium** from scratch: a desktop app for one person to read, keep and write.
This brief is self-contained. Read all of it before writing code. Where it says **ask the user**,
stop and ask; everything else is decided.

---

## 1. What it is

Librarium is a personal notebook and library for slow, careful intellectual work: reading thinkers
closely, quoting them exactly, and letting your own ideas grow on top of what you read.

It has five activities:

1. **Write notes.** Everything the user writes is a note: named, in folders, linked to each other.
   **Any note can be a day:** a daily note is an ordinary note with a date, today's is always one
   step away, and dated notes can be browsed in date order. There is no separate "day" kind.
2. **Build a library.** Save a web page from its address (a faithful PDF plus its clean text). Add
   PDFs, images and EPUBs. Read them all in one reader.
3. **Capture as you read.** Select a passage (or a region of a page or image, in one part or
   several) and keep it with your own words. A capture always points back to its exact place in
   its source.
4. **Connect.** Link notes and items, and place a capture anywhere in your writing, where it shows
   as the quotation with its citation. Everything lists what points to it.
5. **Find.** One search over everything, ranked, with highlighted passages that open at the exact
   place.

The user is a single person on a Mac (Apple silicon, macOS 15). There are no accounts, no cloud
and no collaboration.

## 2. Principles (every decision is tested against these)

| Principle | In practice |
|---|---|
| You own it, forever | All user material is plain, open files in a folder the user chooses, readable without the app for decades. |
| Research-grade rigour | Every quotation traces to its exact place in its source; a citation is never silently wrong. |
| Connection first | Linking is effortless, and links survive renames and moves. |
| Low friction | Capturing and writing cost almost nothing. Words the user types are never lost. |
| Calm, never dominating | The app never pushes, nags or decides. No suggestions, streaks or reminders. |
| Simple yet expressive | Few concepts, combined. Features are added when real use shows they are needed, and removed when they stop earning their place (§4.5). |
| Composable | Small modules with clear contracts; features can be added or removed without touching others. |

## 3. Technology (decided)

- **Tauri 2**, pinned to 2.x: do not upgrade to Tauri 3 (alphas appeared in October 2026).
  Minimum macOS **15.0** (`bundle.macOS.minimumSystemVersion`).
- **Backend:** Rust.
- **Interface:** **plain TypeScript** with **Vite** and a small signal-based reactive store; no UI
  framework. **ts-rs** generates the interface's TypeScript types from the `contracts` crate. It runs in the system webview (WebKit on macOS). There is no network port: the
  interface talks to the backend only through Tauri commands, events and channels.
- **SQLite** (via `rusqlite` or `sqlx`; your choice, justify it) for disposable indexes, one file
  per derived view, with **FTS5** in its default mode.
- **CodeMirror 6** for the editor.
- **PDF.js** through its viewer components (`pdfjs-dist/web/pdf_viewer`), with its worker, wasm
  files, cmaps and standard fonts bundled locally and `wasmUrl` set. Without the wasm files,
  JBIG2 and JPEG 2000 scans silently fail to render.
- **foliate-js** for EPUBs, vendored at a pinned commit (its API is not stable).
- Borrow readers; don't write them.
- **Lucide** line icons.
- **IDs:** UUID v7 (RFC 9562), canonical lowercase form.
- **Frontmatter:** YAML, edited byte-precisely (§5.3). Use a format-preserving crate such as
  `yaml-edit`, or `saphyr-parser` plus your own byte-span editing. Say which and why. Never
  `serde_yaml` (deprecated).
- **Tests:** `cargo test` for the backend, Vitest for the interface, and a few end-to-end checks
  only where needed.

## 4. Architecture

### 4.1 The seven primitives

Everything is built from these. If a feature seems to need a new primitive, stop and ask the user.

1. **Store:** the user's folder of plain files. The only source of truth.
2. **Record:** one unit of material (a note, a library item, a capture) with an ID, a kind,
   metadata and content.
3. **Identity:** a permanent ID inside every record, independent of its name and location.
   Everything points at IDs.
4. **Change:** every mutation is applied safely, in order, numbered and announced.
5. **Derived view:** anything computed from records (search, backlinks, counts). Disposable;
   rebuilt from the store.
6. **Reference:** a pointer from one record to another, or to a place inside another (via an
   anchor).
7. **Job:** long work (saving a page, text recognition, indexing) in the background, reporting
   progress.

### 4.2 Three kinds of data, and the invariants

| Kind | What | Where | If lost |
|---|---|---|---|
| **The store** | User material: notes, captures, items, their extracted text | The user's folder | Never acceptable |
| **Derived data** | Indexes and caches | Application Support (§11) | Rebuilt from the store |
| **Operational state** | Unfinished jobs, drafts with their merge base, write intents, per-device preferences | Application Support (§11) | At most an unfinished action is lost, and the app says so |

Invariants (never break these):

- The store alone is enough to rebuild all derived data.
- User files stay readable without the app.
- No write is lost, partial or silent.
- Nothing points at a path or a name; everything points at an ID.
- Derived views never write to the store. **Repair jobs** (refreshing link labels, restoring a
  missing ID) may, but only through the writer's background lane and with a version check.
- The order is always: write the file, then update the index, then update memory.
- Unknown fields and unknown record kinds are preserved, never dropped.

### 4.3 Structure

The backend is a Cargo workspace with one crate per ring and per module. The interface mirrors it
with one folder per ring and per feature. Dependencies point inward, towards `contracts`, and Cargo
enforces most of them by construction.

**Backend:**

```
Cargo.toml                 the workspace
crates/
  contracts/               types, IDs, events, errors, port traits, slot definitions, the API
                           message types; depends on nothing of ours
  kernel/                  the writer (two lanes), safe writes, intents, records and codecs,
                           identity, numbered changes, the derived-view host, the job host,
                           registries, the link parser (§5.4)
  api/                     the application API: plain Rust, typed methods, one typed error, no
                           transport types; tests drive it directly
  adapters/
    fs-macos/              FileSystem
    changes-fsevents/      ChangeSource, with event-ID replay (§6)
    index-sqlite/          IndexEngine (one SQLite file per derived view)
    versions-none/         VersionStore while history is off (§9)
    pagesaver-webkit/      PageSaver
    transport-tauri/       Transport (Tauri commands, events and channels)
  features/
    notes/  daily/  library/  captures/  search/  links/  archive/  ...
  worker/                  the worker binary: parsers run here, never in the app (§4.5)
src-tauri/                 the app crate: the composition root
```

Every crate has a test adapter or fake beside its real implementation.

- **The composition root** (`src-tauri`) is the only crate that names adapters and features. It
  builds each feature with the narrow dependencies that feature uses. No feature receives the
  whole kernel.
- **Tauri manages one `App` value;** nothing else is fetched from Tauri state.

**Interface:**

```
src/
  generated/      TypeScript types generated from `contracts` (ts-rs); never edited by hand
  backend.ts      the ONLY file that talks to the Transport; it imports @tauri-apps/api
  shell/          layout, router, action and key registry, native menu, prefs, undo for app actions
  kit/            dialogs, menus, tree, list/grid browser, toast, formatters, signal store
  editor/         CodeMirror setup and the editor's extension slot
  reader/         reader host + engine registry; one engine per format
  features/       one folder per feature's screens and contributions
```

- **Types are generated** from `contracts` at build time. A test fails if `src/generated/` is out of
  date.
- **Errors** arrive as `BackendError {code, message, data}`.
- **`withGlobalTauri` is off.**

**The rules that keep it modular:**

1. **One write path.** Every file write goes through the kernel's writer (§6).
2. **IDs inside records.** Never key anything by path or name.
3. **Files are the truth.** Derived data is disposable and checked against files at every
   startup.
4. **One door between interface and backend:** `backend.ts` on one side, the Transport and `api`
   on the other.
   - API messages have the JSON-RPC 2.0 shape (requests, responses, notifications), so any
     transport carries them unchanged.
   - Events carry IDs and a sequence number, never record bodies.
   - Streams use Tauri channels.
   - File bytes use `ipc::Response` or the asset protocol, scoped to the library folder.
   - Only the main window has command permissions (`AppManifest::commands`). Webviews showing
     captured pages or EPUBs get no IPC.
5. **Features never depend on each other or read each other's files.** They meet only through:
   - references in records
   - change events
   - **slots**
   - the kernel's record and reference queries

   A feature owns its derived views and job kinds; the kernel hosts them and knows nothing
   feature-specific.
6. **Each feature's fields live under its own prefix** (`notes.folder`, `daily.date`).

**Slots.** A slot is a named place where modules contribute. Every slot's definition lives in
`contracts`, so a module can fill a slot without depending on whoever hosts it. Slots have three
kinds of host:

| Host | Slots |
|---|---|
| Kernel | record kinds, derived views, job kinds, importers |
| Shell | pages, actions, keys, menu items, sidebar sections, side-panel sections, editor extensions, reader engines |
| A feature | anything it offers others, e.g. Notes offers "note actions" that Archive fills |

Every registry rejects duplicate IDs and shortcut collisions at startup, and keeps an explicit
order.

**Vocabulary:**
- An **action** is a user-facing command: `{id, title, keys, when, run, menu}`.
- An **API call** is a method of `api`, carried by the Transport.

**Direction tests** (from milestone 0, on both sides). Cargo prevents cycles; a test reading
`cargo metadata` enforces these edges, and `dependency-cruiser` (or `eslint-plugin-boundaries`)
enforces the interface's.

Allowed:
- `features → contracts, kernel facades`
- `kernel → contracts`
- `adapters → contracts`
- `api → contracts, kernel`
- `src-tauri → everything`

Forbidden:
- feature → feature
- kernel or `api` → feature
- feature or kernel → adapter
- any interface file other than `backend.ts` → `@tauri-apps/api`
- `shell`, `kit`, `editor`, `reader` → `features`
- interface `features/<a>` → `features/<b>`

Guards, also tested: no kernel crate names a feature, even as a string.

### 4.4 Ports

A port is a trait in `contracts`. Every port has a real adapter and a test adapter, and one
shared test suite runs against both.

| Port | Real adapter | Test adapter |
|---|---|---|
| FileSystem | macOS file system with `F_FULLFSYNC` | In-memory fake that **drops unflushed writes on a simulated crash** |
| ChangeSource | FSEvents with event-ID replay | Scripted events |
| IndexEngine | SQLite, one file per derived view, FTS5 in its default mode | In-memory SQLite |
| VersionStore | `none` (history is off, §9) | Recording fake |
| PageSaver | WebKit through the system webview (`WKWebView.createPDF`, macOS 11+) | Stored fixture pages |
| TextRecognizer | Apple Vision, in the worker | Stored results |
| Transport | Tauri commands, events and channels | In-process transport |
| Clock | System clock | Fixed clock |
| IdGenerator | UUID v7 | A fixed sequence |

- The FileSystem port stays narrow on purpose: the kernel owns the safe-write algorithm, and the
  port is where faults are injected.
- Adapters that slot in without other changes: a git or snapshot VersionStore, Tantivy as an
  IndexEngine, an HTTP Transport, Tesseract as a TextRecognizer, an external Chromium PageSaver.

### 4.5 Isolation, measurement and pruning

**Worker processes.** Parsers of untrusted or heavy input run in a separate worker process (the
`worker` crate's binary), never in the app:
- PDF text extraction
- EPUB parsing
- image decoding for recognition
- text recognition

Workers:
- Speak JSON-RPC over stdin/stdout.
- Run with a 30-second timeout per call and a 2 GB memory ceiling (watched by the job host).
- Are restarted after a crash, a hang or the memory ceiling; the job is retried once and then
  reported.

WebKit already isolates page content in its own processes, so page saving runs through the app's
webview.

**Architecture report.** An `arch-report` test prints, at the end of every milestone:
- the module dependency edges
- the API-call count
- each slot's contributors
- timings against the budgets in §8

Every milestone report includes it.

**Pruning.** Structure that stops earning its place is removed, with the user's confirmation:
- **A feature module** the user hasn't used for three months is proposed for removal.
- **A feature-owned slot** with a single contributor for three milestones is folded back into
  that contributor.
- **When a record kind's format changes for the second time,** add a migration test suite with
  sample files from every version.

## 5. Data on disk

### 5.1 Layout

On first run, ask the user to choose the library folder (there is no silent default). If the
chosen folder is in iCloud Drive, say so once and explain that the app's own data stays outside
it. Ask how to treat a non-empty folder.

```
<library folder>/
  notes/0192f3a4-...-jacques-ellul.md
  notes/0192f4c1-...-2026-10-02.md       (a daily note)
  notes/Thinkers/...                     (the user's folders)
  captures/0192f3b0-....md
  captures/0192f3b0-....anchor.json
  captures/0192f3b0-....region-1.png
  items/0192e7c2-...-some-essay/
    record.json
    original.pdf                         (added files: the untouched original)
    snapshots/2026-10-02T091400Z/page.pdf
    snapshots/2026-10-02T091400Z/text.json
    extracted/text-v1.json               (regenerable: PDF text, OCR results, stamped with
                                          the extractor's version)
  .librarium/
    library.json                         (the library's ID)
    lock
    .gitignore                           (ignores lock)
```

- **File names** start with the record's ID, followed by a slug.
- **The slug follows the title** when the title changes: rename the file first, then rewrite its
  frontmatter. A crash in between leaves a correct ID and a stale title, which the startup check
  repairs.
- **A daily note's slug is its date.**
- **Identity always comes from the ID inside the file,** never from the name or path.
- **Extracted text and recognised text are stored files,** so deleting the index never re-runs
  text recognition.

### 5.2 The record envelope

```yaml
id: "0192f3a4-7c1e-7b2a-9f00-3e5d8c1a2b44"
kind: "note"
kind-version: 1
created: "2026-10-02T09:14:00Z"
title: "Jacques Ellul"
notes.folder: "Thinkers"
```

**Reserved kernel keys:** `id`, `kind`, `kind-version`, `created`, `title`, `copied-from`.

**Versioning:**
- `kind-version` covers the reserved keys and the kind's own fields.
- Module fields (`module.key`) change only by addition: a key never changes meaning.
- A record with a newer `kind-version` than the app knows opens read-only.
- Old versions are upgraded in memory when read, and written at the new version only when the
  user edits the record.

**Formats:**
- Text kinds (note, capture) are Markdown with this frontmatter.
- Binary kinds (library items) use `record.json` with the same fields, plus `sha256` of the
  original and its provenance (source address, author, publication, published date, saved-at,
  saved-with).

**Daily notes:** a daily note is an ordinary note with `daily.date: "2026-10-02"`, set by the
optional Daily module.
- `daily.date` is a local calendar date fixed at creation.
- **The day starts at 4 a.m. by default,** a setting the user can change, so writing after
  midnight lands on the day it belongs to.
- "Open or create today's note" (⌘T) is one writer operation, so two presses never make two
  notes. It waits for the startup check.
- If two notes share a date, both are listed and ⌘T opens the earlier one.
- Its title defaults to the date, and the user may rename it.
- Removing the Daily module leaves these notes as ordinary notes.

### 5.3 Frontmatter

**When writing:**
- Flat keys (a module's fields use a `module.` prefix).
- Values are quoted strings, numbers, `true`/`false`, or lists of these.
- Dates are quoted ISO 8601 strings.
- No YAML anchors, aliases or `!` tags. Obsidian's `tags:` property, a list of strings, is
  allowed.

**When reading:** frontmatter may be any YAML 1.2.

**Preservation:**
- The app changes only the bytes of the keys it writes, so unknown keys, their values, comments
  and order are preserved exactly.
- Frontmatter that doesn't parse is shown, never rewritten.
- Structured data (anchors, provenance) lives in JSON files paired with the record by ID.

### 5.4 Links and embeds

**Grammar:** `[[label|uuid]]`. This is Pandoc's `wikilinks_title_before_pipe` form, also used by
comrak and Dendron.
- The ID follows the **last** unescaped `|` and must be a canonical UUID.
- In labels, `\`, `[`, `]` and `|` are escaped with `\`, and newlines become spaces.
- In table cells, the separator is also written `\|`.
- Links inside code spans and code blocks are not links, so parse with a real Markdown parser,
  not a regex.

**Behaviour:**
- The editor shows only the label.
- Links resolve by ID, so renames break nothing.
- The label is a cache, refreshed by a repair job (§4.2). A stale label is never an error.
- A missing or damaged ID is restored from the label **only when exactly one record** has that
  title. Otherwise the link is listed as unresolved for the user to choose.
- In Obsidian these links show the ID as their text, and clicking one creates a new note. That is
  accepted; such a note becomes an ordinary new record.

**Embeds:** a capture placed in writing is written `![[label|uuid]]`, where the label is the first
words of the quotation. It renders as the quotation with its citation. An "Export with
quotations" command writes a copy of a note with each embed expanded, for reading outside the
app.

**One parser:** the kernel's link parser reads links and embeds. A shared fixture file of link
cases is tested by both the Rust parser and the editor's parser.

### 5.5 Anchors (where a capture points)

Each capture's `.anchor.json` records `{id, source, snapshot, parts: [...]}`. Each part has a
target in the **W3C Web Annotation** model:
- A `TextQuoteSelector`: the exact text plus about 32 characters of context on each side.
- A `TextPositionSelector` hint, in Unicode code points. Convert from JavaScript's UTF-16
  offsets.
- Refined by one of:
  - `FragmentSelector` `page=N` for PDFs (RFC 8118)
  - `xywh=percent:` for image regions
  - an EPUB CFI

An export command writes one standard W3C annotation per part.

- **Anchors refer to stored extracted text** (`text.json`, `extracted/`), stamped with the
  extractor's version.
- **Sidecars are paired with captures by the ID inside them,** not by file name. A sidecar with no
  capture is listed as an orphan, never deleted.

**Finding a place again:**
1. Try the position, and check that the quote is there.
2. If not, search for the exact quote, using the context.
3. If not, use fuzzy matching (Hypothesis's approach, with the `approx-string-match` algorithm).

- A fuzzy match above a set score is shown as "moved" until the user confirms it.
- Below that score, the anchor is listed as lost: never deleted, never drawn in the wrong place.

### 5.6 Snapshots

Saving a page again adds a new snapshot to the same item. Captures stay with the snapshot they
came from.

## 6. Behaviour (decided)

**One writer, two lanes.** All writes to the store go through one writer: the interactive lane
(editor saves, user actions) always goes before the background lane (repairs, imports).
- Each operation has one commit point:
  - sidecars before the `.md` file
  - a rename before a rewrite
  - imports staged in Application Support and moved in with one rename
- An operation that must change several files writes an **intent** first, and unfinished intents
  are redone at startup.
- Background batches flush each file, then issue one `F_FULLFSYNC`. Apple SSDs manage only about
  46 full flushes a second.
- The writer never waits on anything that waits on it.

**Safe writes:**
1. Write a temporary file, with a unique name, in the same folder.
2. Flush it (`File::sync_all`, which uses `F_FULLFSYNC` on macOS).
3. Rename it over the target, or create exclusively (`RENAME_EXCL`) for new files.
4. Flush the folder.

**Versions:**
- A record's version is its content hash. A save carries the version it was based on.
- The editor's draft keeps the base text and its hash, which is what makes a three-way merge
  possible.
- Before writing, the writer finds the record's current path by ID. If the file is gone, the save
  is refused, never re-created.
- If the file changed since, refuse, try an automatic three-way merge, and otherwise show both
  versions. Never overwrite silently.
- The app recognises its own writes by the hash it wrote.

**Outside edits.** The ChangeSource adapter uses FSEvents directly (the `notify` crate cannot
replay). It stores the last event ID and the volume's UUID in app data (§11), and at startup
replays every event since then, so only files changed while the app was closed are checked. An
event triggers a check by size, modification and change times (nanoseconds) and inode.
- Any file whose modification time isn't older than the previous check is hashed (git's "racy"
  rule).
- A full check of every file runs on first run, when the event IDs or the volume don't match,
  whenever FSEvents reports dropped or merged events, and on a timer.

**Change stream.** Changes live in memory only and carry sequence numbers.
- A window that made a change waits until the index has applied it, so it always shows its own
  edits.
- Until the startup check finishes, views show "checking".

**Index:**
- Each derived view has its own SQLite file (§11), stamped with its own schema version. A mismatch
  rebuilds that view alone, into a new file that replaces the old one when it's done.
- The kernel keeps the records table (id, kind, title, path, fingerprint) in its own file.
- Passages of up to about 120 words.
- Search features: title weighted above body (BM25), prefix search, `"phrases"`, `-exclusions`,
  snippets, and the kind filter applied *before* the limit.
- A visible "Rebuild index" command.

**Jobs:**
- Page saves and text recognition resume automatically after a restart, with a brief note
  ("Resumed 3 saves").
- Running jobs show in the status bar. A Jobs view in the side panel lists running, failed (Retry,
  Dismiss) and recent jobs, with Cancel.
- Each job has an idempotency key and checks for existing output before its final write. Job
  payloads hold IDs, not content.

**Two files with one ID** are first classified:
- **A conflict** (a sync-conflict name, or mostly the same text) is shown as one record with two
  versions to compare.
- **A copy** gets a new ID plus `copied-from`.
- The original is the one at the indexed path. With no index, it's the one with the canonical
  name, then the earlier creation time.
- IDs are rewritten only when the folder has been quiet and no git operation is in progress.
- Never merge silently.

**Undo** has two scopes, chosen by focus:
- Text undo is CodeMirror's history for the open note.
- App actions (rename, move, archive, restore) each record an inverse with the version they
  expect, and refuse if the file has changed since. Their toasts offer Undo.
- Permanent deletion can't be undone.

**Deleting** is two steps: archive first, then delete permanently only with explicit
confirmation.

**Never lose words:**
- About 300 ms after each change, the editor sends a draft to the backend. The backend keeps it in
  Application Support (§11) until the queued save succeeds.
- Saves happen after 1 second idle, and on blur, navigation and window close.
- Drafts newer than their file are offered back at startup.
- WebKit storage is never the only copy.

**Errors are calm:**
- Status messages and toasts for most things.
- Dialogs only for conflicts and destructive confirmations.

## 7. Interface design

### 7.1 Look

Quiet and content-first, after Obsidian's defaults: the system font, true neutral greys, one violet
accent used sparingly, small monochrome line icons. Light and dark themes; the theme follows the
system unless the user chooses one.

### 7.2 Layout

One window; only regions scroll, never the window.

1. **Ribbon:** 44 px, far left. The sidebar toggle at the top; one icon per page (Today, Notes,
   Library, Search, Archive); then the command palette, shortcuts and settings at the bottom. The
   current page's icon is in the accent colour.
2. **Sidebar:** 260 px, can be hidden. A filter box, then Notes (with daily notes in their own
   foldable group, newest first, contributed by the Daily module) and Library as foldable
   sections; empty sections say so in one faint line.
3. **Workspace:** a 40 px header (back and forward on the left, the title centred in small muted
   text, actions on the right) above the page. Page content sits in a centred 700 px column with
   generous space below.
4. **Side panel:** 320 px, right, optional, hidden at first; secondary information about what is
   open, and the Jobs view.
5. **Status bar:** 24 px, full width. Messages and running jobs on the left, details on the right.

### 7.3 Values

| Token | Light | Dark |
|---|---|---|
| Page background | #ffffff | #1e1e1e |
| Alternate background | #fafafa | #242424 |
| Sidebar background | #f6f6f6 | #262626 |
| Border / strong border | #e4e4e4 / #dadada | #333333 / #3f3f3f |
| Ink | #222222 | #dadada |
| Muted text | #5c5c5c | #b3b3b3 |
| Faint text | #6e6e6e | #949494 |
| Accent | hsl(258 88% 66%) | hsl(258 88% 66%) |
| Accent as text | #6d3ff0 | #a68bfa |
| Solid accent behind white text | #6d3ff0 | #6d3ff0 |
| Hover / active tint | black 6.7% / 9% | white 7% / 11% |
| Selection | accent at 22% | accent at 33% |

**Type:**
- System UI font; SF Mono or Menlo for code.
- Reading text 16 px, line height 1.5 (14 or 18 px by setting).
- UI 15 px, line height 1.3; small UI 13 and 12 px.
- Page titles 1.618 × reading size, bold, letter spacing −0.015 em.

**Space and shape:**
- A 4 px grid.
- Radii 4, 8 and 12 px.
- Shadows only on dialogs (two soft layers).

**Components:**
- Icon buttons are 28 × 28, transparent until hovered.
- Buttons have a 4 px radius and a subtle border; the primary button is solid accent with white
  text.
- Inputs show an accent ring on focus.
- Dialogs are centred, with a 12 px radius, over a 25% dimmed backdrop.
- Toasts are brief, inverted, at the bottom centre.
- Empty states are one calm sentence in a lightly dashed box.

**Contrast:** text meets WCAG 2.2 AA in both themes.

### 7.4 Interaction

**One registry.** Actions are defined once in the action registry. The ribbon, the command
palette, the shortcuts dialog and the **native macOS menu bar** are generated from it.
- The menu bar always contains the standard App menu (with Settings… ⌘,), an Edit menu (Undo,
  Redo, Cut, Copy, Paste, Select All), and Window and Help menus. Without them, ⌘C, ⌘V and ⌘Z stop
  working in a Tauri app.
- Each action has a `when` condition for availability.
- When the editor has focus, CodeMirror's keymap wins, except for the app's reserved shortcuts
  below.
- Key handlers ignore IME composition.

**Shortcuts** (⌘ on a Mac):

| Shortcut | Action |
|---|---|
| ⌘T | Open today's note (created if missing) |
| ⌘O | Open a note or library item |
| ⇧⌘P | Command palette |
| ⌘/ | Keyboard shortcuts |
| ⌘, | Settings |
| ⌘\ | Sidebar |
| ⌘⌥\ | Side panel |
| ⌘⌥← / ⌘⌥→ | Back and forward |
| ⇧⌘F | Search |

**Behaviour:**
- Navigation keeps history, so back and forward work.
- Per-device preferences (theme, text size, panels open, sections folded, window size) are saved
  by the backend (§11), not in WebKit storage.

**Accessibility:**
- The palette and the open dialog follow the WAI-ARIA APG combobox-with-listbox pattern, inside a
  modal `<dialog>`.
- The sidebar follows the APG tree pattern: one tab stop, no buttons inside rows.
- Toasts and status messages use `role="status"`.
- Every icon button has a spoken label and a tooltip with its shortcut.
- Animations respect reduced motion.
- Everything works from the keyboard.

**The editor:**
- Markdown with live preview: syntax is hidden except on the line being edited.
- Headings, emphasis, `==highlight==`, lists, tasks, quotes, code and tables.
- `[[` opens link suggestions.
- Capture embeds render in place, as an editor extension contributed by the Captures module.

## 8. Build order and acceptance

Build in this order. Each milestone ends with:
- a working app
- passing tests
- a short note to the user saying what was built and how to try it

Commit after each milestone.

| # | Milestone | Done when |
|---|---|---|
| 0 | Project setup: the Cargo workspace and crates (§4.3), Tauri 2, TypeScript, Vite, ts-rs generation, the worker binary, lint, tests, direction tests, `arch-report` | `npm run dev` opens an empty window; all tests pass, including the direction tests on both sides; generated types are current; the app can start the worker and get a reply |
| 1 | Store (writer, lanes, safe writes, intents), records, IDs, changes, the records table (id, kind, title, path, fingerprint), ChangeSource with event-ID replay, the startup check | Each port's shared suite passes against its fake and its real adapter; an edit made while the app was closed is found by replay, and by a full check when replay is unavailable; crash tests pass against the durability-modelling fake and a real folder; round trips preserve unknown keys, comments and order byte for byte; an outside edit is detected; a crash mid-rename never leaves two files claiming one ID; duplicate IDs are classified as §6 says |
| 2 | Shell: layout, registries, native menu, palette, shortcuts, settings, themes | The layout and values in §7 match; ⌘C, ⌘V and ⌘Z work in inputs and the editor; every action is reachable from the palette, the menu and the keyboard; VoiceOver reads every control; an axe check passes; the palette opens in under 50 ms |
| 3 | Notes and daily notes, with the editor, autosave, drafts and undo | Text typed up to 1 second before the app process is killed (`kill -9`) is present after reopening; a simulated failed save (read-only file) is retried, reported in the status bar, and the text survives a restart; `[[` inserts `[[label\|id]]`; renaming a note keeps every link working; ⌘T opens or creates today's note, and pressing it twice makes one note |
| 4 | Index (one file per view), search, backlinks, the job host and the worker host (spawn, timeout, memory ceiling, restart); index rebuild and label refresh as the first jobs | Search finds notes with snippets in under 150 ms on 10,000 notes; backlinks list every linking record; deleting the index files and restarting rebuilds everything without re-running text recognition; a worker killed mid-job is restarted and the job retried once |
| 5 | Library: add PDFs, images and EPUBs (text extraction and EPUB parsing in the worker); the reader with one engine per format | Each format opens, zooms and supports find; originals are byte-identical after import (sha256); a JBIG2 scan and a JPEG 2000 PDF render completely; the first page of a 100-page PDF opens in under 500 ms |
| 6 | Captures with W3C anchors, the captures panel, embeds in writing | Against a fixture set of edits (insert before, after and inside the paragraph; reflow), every capture is found again or listed as lost, never drawn in the wrong place |
| 7 | Saving web pages (WebKit), snapshots, provenance, page checks | The text and images visible in the webview appear in the PDF, checked on a list of 10 real pages the user approves; error pages, paywalls and human-verification pages are detected on stored fixture pages; saving again adds a snapshot |
| 8 | Text recognition (Vision), searchable and quotable scans and images | Words in an image can be found and captured; recognition results are stored and survive an index rebuild |
| 9 | Archive and permanent deletion | Nothing is deleted without the two-step confirmation |

**Performance budgets** (checked from milestone 2):
- cold start to usable in under 1.5 seconds with 10,000 notes
- keystroke to paint in under 16 ms

## 9. Not now

Do not build these unless the user asks:

- **Version history.** Undecided: when it comes, it must be stored with the user's files and
  capture edits made outside the app (git or snapshots). The VersionStore port already exists, with
  its `none` adapter; history is a new adapter.
- Sync, accounts, collaboration, mobile.
- A public plug-in API.
- AI features of any kind.
- Pins, review marks, daily-note templates, a calendar, duplicate detection. These are candidate
  small modules for later.

## 10. Working with the user

- Ask one clear question at a time, with options and a recommendation, when something here is
  unclear or missing. Don't guess on data formats.
- Label what you say as a fact, a proposal or an assumption.
- Keep the README current: how to run, the layout, and a dated table of decisions.
  - Each row of the table links to a short MADR-style file in `docs/decisions/` for decisions
    that constrain code or data.
  - Decisions are superseded, never edited.
- Prefer borrowing well-maintained libraries to writing your own, and pin their versions.
- Never touch files outside the user's chosen folder, the project folder and the app's own folders
  (§11).

## 11. App environment

`<identifier>` is the app's bundle identifier.

**App data** lives in `~/Library/Application Support/<identifier>/` and is never synced:
- `settings.json`: the library folder path and per-device preferences, written by the backend.
- `libraries/<library-id>/`: that library's derived data and operational state.
  - `index/` (one SQLite file per derived view, plus the kernel's records table)
  - `changes.json` (the last FSEvents event ID and the volume's UUID)
  - `jobs.sqlite`
  - `drafts/`
  - `intents/`
  - `staging/`

**Logs:**
- Written to `~/Library/Logs/<identifier>/` via `tauri-plugin-log`.
- Panics are logged; nothing is sent anywhere.
- A "Reveal logs" action.

**Running:**
- **Single instance** via `tauri-plugin-single-instance`: a second launch focuses the first
  window.
- **Window size and position** are restored.
- **Packaging:** an ad-hoc signed `.app` for personal use; notarisation only if it is ever
  distributed.
- **A missing library folder** (for example, an unmounted drive) is reported calmly, with a choice
  to locate it or choose another.

