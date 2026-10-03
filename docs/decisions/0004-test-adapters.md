# 0004. Test adapters and shared port suites live in a testkit crate

- Status: accepted
- Date: 2026-10-02

## Context and problem

Every port has a real adapter and a test adapter, and one shared suite runs against both
(BRIEF §4.4). The kernel's tests need fakes, but the kernel may not depend on adapters.

## Decision

`crates/testkit` depends only on `contracts`. It holds the test adapters (in-memory file system
with simulated crashes, fixed clock, ID sequence, scripted change source, in-process worker and
so on) and the shared suites. Real adapters run the same suites from their own tests. The
direction test allows any crate to take `testkit` as a dev-dependency, and nothing else.

## Consequences

The IndexEngine's test adapter is the same SQLite adapter opened in memory (BRIEF §4.4), so it
lives in `index-sqlite` itself.
