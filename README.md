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
