# 0038. Version history, kept with the library

- Status: accepted
- Date: 2026-10-03
- Settles: BRIEF §9 "Version history" (undecided until now); §4.4's VersionStore port stays as
  an optional mirror hook

## Context and problem

The user asked for version control, after research comparing Obsidian's approaches: File
recovery (local, 7 days), Sync's version history (paid, short for attachments), and the Git
plugin (permanent, but known to corrupt repositories in iCloud). The brief requires history
to be "stored with the user's files" and to "capture edits made outside the app".

The user decided:
- the hidden `.librarium/` folder is acceptable;
- "Delete permanently" erases a note's history;
- retention is everything for a day, hourly for a week, daily for three months, then weekly.

## Options considered

1. **Our own append-only snapshot store in the library.** Chosen.
2. **Git with `.git` in the library.** Rejected: iCloud corrupts it, it clashes with a repository
   the user may have, git keys by path, and binaries bloat it.
3. **Git or snapshots in Application Support.** Rejected: not "with the user's files", and lost
   with the Mac.
4. **A read-only view of a git repository the user keeps.** Possible later, alongside option 1.

## Decision

- **A kernel module** (`crates/kernel/src/history.rs`) works through the `FileSystem` port, so
  the test file system applies.
  - **Why the kernel:** like intents and drafts, it is part of keeping the user's writing
    safe, and it needs IDs, outside-edit detection and deletion.
  - **The `VersionStore` port** is still called on every write, as a hook for a future mirror
    (git). It is not used for this.
- **On disk:** `.librarium/history/`, with a README.
  - `objects/<2 hex>/<sha256>`: a version's exact bytes, written once and never changed.
  - `log/<device>.jsonl`: one JSON line per version, written only by this Mac. Each line holds
    the id, kind, path, title, hash, ms, origin, size and device; a separate kind of line,
    `{"forget": id, "ms"}`, hides a record's earlier versions on every Mac.
  - The device ID is random and kept in Application Support (`device.json`).
  - iCloud never sees two Macs writing the same file.
- **What has history:** Markdown records (notes, daily notes, captures). Library items are
  originals and dated snapshots already.
- **When a version is taken:**
  - **After an app write:** at most one per record every 5 minutes; a later save marks the
    record pending, and the maintenance tick takes its latest text once 5 minutes have
    passed.
  - **When the content changes outside the app** (Updated or Renamed in the startup check or
    from FSEvents). A record first seen (Created) is not taken: on a first run or a rebuilt
    index every note looks new.
  - **Around a restore:** the text before it (`before-restore`) and the restored text
    (`restore`).
  - **Never twice for the same bytes in a row.**
- **Retention,** pruned at most once a day:
  - every version for 24 hours;
  - then the newest per hour for 7 days, per day for 90 days, and per week after that;
  - always the newest version of a record.

  A Mac prunes only its own log. An object is removed only when no log of any Mac refers to
  it.
- **Delete permanently** removes the record's lines from this Mac's log, adds a `forget` line,
  and collects unreferenced objects.
- **Deleted outside the app** (Finder, sync): the history stays. Archive → "Deleted outside
  Librarium" brings a note back with its ID, at its old path or at its canonical name in the
  same folder (`Tx::bring_back`).
- **Restore** puts back a version's body. The title and properties stay as they are now, so a
  restore never moves or renames the file or un-archives it. It requires the version the user
  is looking at (`base_version`), and the text before is kept as a version, so Undo is
  another restore.
- **API:** `history.versions`, `history.read`, `history.diff` (line diff of bodies, computed
  with `similar`), `history.restore`, `history.deleted`, `history.bringBack`.
- **Interface:**
  - A History side-panel section for the note shown: versions by day, with time and cause.
  - A comparison dialog: removed and added lines, long unchanged runs folded, Copy its text,
    and Restore this version (with Undo).
  - "Show history" (⌥⌘Y) in the File menu.
- **History never fails a write.** Its own errors are logged and skipped. The object is
  written before its log line, so a crash leaves at most an unreferenced object, which pruning
  removes.

## Consequences

- **The library carries its history.** It syncs with iCloud, and another Mac sees it (logs
  are re-read when they change).
- **Size:** each version is a whole copy of a note, uncompressed so that it is readable
  without the app. Retention bounds it.
- **A version whose object hasn't arrived yet through sync** reads as "not on this Mac yet".
- **Each new version rewrites the Mac's log** (the file-system port has no append). That is
  fine at the expected rate; a true append can come later.
- **Not yet done:** history for items' `record.json`, a whole-library "as of" view, and a
  read-only view of a user's own git repository.
