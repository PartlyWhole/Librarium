# 0008. A full check after an unclean shutdown

- Status: accepted
- Date: 2026-10-02

## Context and problem

At startup the change source replays events since the saved event ID (§6). After a power
loss or a killed process, both the FSEvents history and the disposable index may lag the
folder, so a replay could miss a change and the index could point at a file that never
became durable.

## Decision

`.librarium/lock` is written when a library opens and removed when it closes. If it is still
there at the next open, the previous run did not close cleanly, and the startup check is a
full one (reason: "the app did not close cleanly"). Fingerprints still avoid re-reading
unchanged files, so a full check stays cheap.

## Consequences

Crash tests assert that every restart after a crash ran a full check.
