# Architecture

Librarium is a Tauri 2 app with a Rust backend and a plain TypeScript interface. There is no UI
framework, except React inside boards, because Excalidraw needs it. What the app does is in
[SPEC.md](SPEC.md); the files it reads and writes are in [FORMAT.md](FORMAT.md).

## The shape

```
src-tauri/src/            the backend: one crate, one module per concern
  main.rs                 app setup: plugins, window, menu, commands
  commands.rs             every Tauri command, thin: parse → call a module → return
  store/                  the library folder: the only code that writes to it
    write.rs              safe writes, and the write lock that orders them
    frontmatter.rs        byte-preserving YAML frontmatter edits
    record.rs             read and write records, rename and move, sidecars
    scan.rs               walk the folder; spot outside changes (startup scan + live watch)
    repair.rs             duplicate IDs, missing IDs, unfinished operations
  index.rs                one SQLite file: records, links, full-text search
  links.rs                the [[label|id]] parser
  notes.rs  daily.rs  boards.rs  captures.rs  archive.rs  history.rs
  library/                import, text extraction (PDFKit, EPUB), text recognition (Vision)
  websave.rs              saving pages with WKWebView
  jobs.rs                 background work that resumes after a restart
  settings.rs             settings.json and drafts in app data

src/                      the interface
  main.ts                 start-up: builds the layout and opens the library
  backend.ts              the only file that calls Tauri; typed wrappers for every command
  types.ts                generated from the backend's types (ts-rs); never edited by hand
  ui/                     small DOM kit: h(), signals, dialog, menu, toast, tree, picker, icons
  app/                    layout, tabs, actions (menu + palette + keys), undo, settings page
  notes/                  note page and the CodeMirror editor
  reader/                 the reader, with pdf/, epub/ and image/
  captures/  library/  boards/  search/  archive/  history/  websave/
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

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | the app |
| `npm test` | both sides' tests |
| `npm run release -- <version> "<notes>"` | publish an update |
