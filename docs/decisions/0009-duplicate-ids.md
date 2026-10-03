# 0009. Classifying two files with one ID, and when IDs are rewritten

- Status: accepted
- Date: 2026-10-02

## Context and problem

§6 says a second file with an ID is a **conflict** (a sync-conflict name, or mostly the same
text) or a **copy** (gets a new ID and `copied-from`). A Finder duplicate has exactly the
same text as its original, so "mostly the same text" alone would call it a conflict.

## Decision

Checks in this order:

1. A sync tool's conflict name (`sync-conflict`, `conflicted copy`, `(conflict…`, or iCloud's
   `name 2.md`, which our slugs never produce, having no spaces): **conflict**.
2. A deliberate copy's name (Finder's `… copy`, `… copy 2`): **copy**.
3. Line similarity of at least 0.8: **conflict**.
4. Otherwise: **copy**.

The original is the file at the indexed path; with no index, the one with the canonical name,
then the earlier creation time. IDs (for copies, and for files without an ID or with a
damaged one) are written only when no outside change has arrived for 3 seconds and no git
operation is in progress (`.git/index.lock`, `MERGE_HEAD`, `rebase-*`, `CHERRY_PICK_HEAD`,
`REVERT_HEAD`). Such a file is renamed to its canonical name first, then given its ID, as an
intent. Known duplicates are kept in the records view's metadata, so a replayed startup still
lists them.

## Consequences

Conflicts are never merged silently; the original's `conflicts` lists them for comparison.
