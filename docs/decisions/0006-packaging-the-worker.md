# 0006. The worker is bundled only when packaging

- Status: accepted
- Date: 2026-10-02

## Context and problem

Tauri's `externalBin` copies the worker into the `.app`, but its build script requires the
binary to exist on every build, including `cargo test` and `cargo clippy`.

## Decision

`externalBin` lives in `src-tauri/tauri.bundle.json`, merged only by `npm run build`, which
first builds the release worker and stages it with its target-triple suffix. In development the
app finds the worker next to its own executable in `target/debug/`; `npm run dev` builds it
first.

## Consequences

`cargo build` alone does not build the worker; `npm run dev`, `npm run build` and the tests that
need it do.
