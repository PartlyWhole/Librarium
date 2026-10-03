# 0001. rusqlite (bundled) for the SQLite index engine

- Status: accepted
- Date: 2026-10-02

## Context and problem

BRIEF §3 leaves the SQLite crate open (`rusqlite` or `sqlx`) and asks for a justification.
Indexes are disposable derived views, one SQLite file per view, with FTS5 in its default mode.

## Options considered

- **rusqlite** with the `bundled` feature: synchronous, thin over the C API, compiles a known
  SQLite with FTS5 enabled.
- **sqlx**: async, pooled, compile-time checked queries against a live database.

## Decision

`rusqlite` with `bundled`.

- The kernel's hosts are synchronous threads (the writer's lanes, the view host); an async
  runtime would add a second concurrency model for no gain.
- `bundled` pins the SQLite version and guarantees FTS5 is compiled in, independent of the
  macOS system library.
- One connection per view file, owned by the view's thread: no pool needed.
- sqlx's compile-time checks need a database at build time, which disposable,
  versioned-per-view schemas make awkward.

## Consequences

- The `index-sqlite` adapter owns all SQL; features see only the IndexEngine port.
- SQLite upgrades happen when we bump `rusqlite`.
