# 0012. A Desktop port for showing things in Finder

- Status: accepted
- Date: 2026-10-02

## Context and problem

"Reveal logs" (§11) and "Show library folder in Finder" ask the OS to show a path. The API may
not name adapters, and no port in §4.4 covers this.

## Decision

A `Desktop` port in `contracts` with one method, `reveal(path)`. The real adapter
(`adapters/system::MacDesktop`) runs `open -R`; the test adapter records requests. It never
changes files.

## Consequences

Future OS hand-offs (opening a source address in the browser) go here too.
