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
| `npm run build` | Build an ad-hoc signed `Librarium.app` (with the worker bundled) |
| `npm test` | All tests: Vitest, then `cargo test --workspace` |
| `npm run lint` | ESLint, dependency-cruiser direction rules, clippy and rustfmt |
| `npm run gen:types` | Regenerate `src/generated/` from the `contracts` crate |
| `npm run dev:mock` | The interface alone in a browser, on a sample library (port 1421) |
| `npm run arch-report` | Print the architecture report (edges, API calls, slots, timings) |

## Layout

```
BRIEF.md                 the project's reference
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
tests/                   interface-wide tests (direction rules) and fixtures
docs/decisions/          MADR-style decision records
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
