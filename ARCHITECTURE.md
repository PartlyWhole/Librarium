# Architecture

Librarium is a Tauri 2 app with a Rust backend and a plain TypeScript interface. There is no UI
framework, except React inside boards, because Excalidraw needs it. What the app does is in
[SPEC.md](SPEC.md); the files it reads and writes are in [FORMAT.md](FORMAT.md).

## The shape

```
src-tauri/src/            the backend: one crate, one module per concern
  lib.rs                  app setup: plugins, the window, quitting, blocked navigation
  app.rs                  the app's state: settings, the open library, opening and closing
  commands.rs             the `call` command: one match from method name to module function
  types.rs  error.rs      what crosses to the interface (exported to src/types.ts), errors
  store/                  the library folder: the only code that writes to it
    write.rs              safe writes, intents, and the write lock that orders them
    frontmatter.rs        byte-preserving YAML frontmatter edits
    record.rs             the kinds, reading records, names and paths
    save.rs               create, save (with three-way merge, merge.rs), set fields
    relocate.rs           rename, move, permanent delete; finishing them after a crash
    files.rs              sidecars, item folders, staged imports
    folders.rs            user folders and order.json
    scan.rs               walk the folder; outside changes (startup scan + live watch)
    repair.rs             duplicate IDs, missing IDs
  index.rs                one SQLite file: records, links, full-text search
  links.rs                the [[label|id]] parser
  notes.rs  daily.rs  archive.rs  history.rs  captures.rs  boards.rs
  library/                import, text extraction (PDFKit, EPUB), recognition (Vision), snapshots
  websave/                saving pages with a hidden WKWebView, and the page checks
  reader.rs               files for the reader: the `bytes` command and the asset: protocol
  jobs.rs                 background work that resumes after a restart
  settings.rs             settings.json and drafts in app data
  devbridge.rs            development only: a browser can drive the backend (see below)

src/                      the interface
  main.ts                 start-up: imports the features and starts the shell
  backend.ts              the only file that calls Tauri
  types.ts                generated from types.rs (ts-rs); never edited by hand
  ui/                     a small DOM kit: h(), signals, dialogs, menus, toasts, tree, pickers
  app/                    the shell: layout, tabs, router, actions (menu bar, palette, keys),
                          undo, side panel, jobs, settings, the Notes and Library folder pages
  notes/                  the note page, embeds, history; editor/ is CodeMirror
  reader/                 the item page: pdf/, image/, epub/, and what captures draw with
  captures/  boards/  library/  websave/  search/  archive/  updates/
```

## Rules

1. **Only `store/` writes to the library folder.** Each write is a safe write under one lock. A
   change to several files writes an intent first, so it finishes after a crash.
2. **Write the file, then update the index, then tell the interface.** The index is disposable
   and can always be rebuilt from the files.
3. **Point at IDs, never at paths or names.**
4. **Keep what you don't understand.** Unknown frontmatter keys, kinds and files survive
   untouched.
5. **Modules call each other directly.** There are no plug-in registries and no interfaces with a
   single implementation. If two features need the same thing, it moves to `store/`, `ui/` or
   `app/`.
6. **Only `backend.ts` talks to Tauri.** Webviews showing saved pages or books get no IPC.
7. **Nothing is spawned.** Parsing and recognition run in-process on background threads. Native
   calls are wrapped so that a failure fails the job, not the app.

## Tests

Tests guard what can't be seen by looking at the app: the user's data.

- `src-tauri/tests/`:
  - frontmatter round trips, byte for byte
  - the link grammar (shared cases in `tests/links.json`)
  - slugs
  - safe writes and crash recovery
  - duplicate-ID classification
  - reading the fixture library in `tests/library/`
- `src/captures/anchor.test.ts`: finding a capture's place again after edits.

Interface behaviour is checked by running the app (`npm run dev`), not by unit tests.

## Trying it without your library

`LIBRARIUM_DATA=<dir>` gives a run its own app data (settings, index, drafts), so it opens
whatever library that `settings.json` names, never yours. In a debug build,
`LIBRARIUM_BRIDGE=<port>` also lets a browser at `http://localhost:1420/?bridge=<port>` drive
the real backend, which is how the interface is clicked through and checked from outside the
window. Native menus, file dialogs and window drops only work in the app itself.

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | the app |
| `npm test` | both sides' tests |
| `npm run release -- <version> "<notes>"` | publish an update |
