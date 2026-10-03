# 0015. A read-only or locked file is never replaced

- Status: accepted
- Date: 2026-10-02

## Context and problem

Safe writes rename a temporary file over the target. On macOS a rename replaces a file even if
the file itself is read-only, so the user's own "read-only" (or Finder's "Locked") would be
silently ignored. §8 also asks that a simulated failed save (a read-only file) is retried and
reported.

## Decision

The FileSystem port's `stat` reports `writable` (a write permission bit, and no immutable
flag). The writer refuses to save, rename or rewrite a record whose file isn't writable, with
an error the interface reports calmly ("“X” is read-only, so it can’t be saved.") while it
retries. The draft is kept until a save succeeds.

## Consequences

Making the file writable again lets the next retry save it.
