# 0007. How the test file system models durability

- Status: accepted
- Date: 2026-10-02

## Context and problem

Crash tests (§8, milestone 1) need a fake that drops unflushed writes on a simulated crash.
How faithful must it be? A naive model, where each folder's entries become durable only when
that folder is flushed, lets a crash between flushing the new and the old folder of a
cross-folder rename leave **both** names on disk. APFS cannot do that: a rename is a single
journal transaction.

## Decision

`testkit::memfs::MemFs` models:

- file contents: durable after `flush_file(Full)`, or `Data` followed by any full flush;
- folder entries: an ordered log of changes; flushing a folder commits its changes, and a
  rename's two halves always commit together (as APFS's journal does);
- times: a crash restores each file's times as of its durable contents;
- a crash after `n` operations (`crash_after`) for sweeping every step of an operation.

A process crash on a real folder is modelled by `FaultFs`, which wraps the real adapter and
fails every operation after `n`.

## Consequences

The crash sweeps (create, save, set fields, rename across folders) run against both models.
If we ever support a file system without journalled renames, this model must change.
