# 0018. The derived-view host keeps views in step by record hashes

- Status: accepted
- Date: 2026-10-02

## Context and problem

Derived views must be disposable, checked against the files at every startup, and rebuilt
alone when their schema changes (§6). Changes made while the app was closed, or before the
view host started, must still reach every view.

## Decision

- Each view (search, links, …) gets its own SQLite file in `index/`, plus a `_seen` table of
  `(record id, content hash)` that the host maintains.
- At startup, a missing or differently versioned view is rebuilt into a new file that replaces
  the old one when done; otherwise the host applies every record whose hash differs from
  `_seen` and removes records that are gone.
- Then the host applies numbered changes in order on its own thread and reports
  `event.indexed {seq}`, so a window can wait for its own edits.
- Non-Markdown kinds give views their text through a `TextSource` contributed per kind, from
  stored files only: rebuilding never re-runs text recognition.
- Replacing a record's passages uses a side table of passage row IDs (FTS5's unindexed
  `record` column would make every replacement scan the table).

## Consequences

A first full index of 10,000 notes takes about 1 s; search on them takes a few
milliseconds.
