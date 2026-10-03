# 0011. A record's path is the truth for its folder; renames are intents

- Status: accepted
- Date: 2026-10-02

## Context and problem

§5.2 shows `notes.folder: "Thinkers"` in frontmatter, and §5.1 puts notes in the user's
folders. If the user moves a file in Finder, the field and the path disagree.

## Decision

- The path wins. A kind may name a field that mirrors its subfolder (`notes.folder`); the app
  writes it when it moves a record, and treats it as a cache otherwise.
- Renaming or moving is one intent: rename the file (the slug follows the title), then
  rewrite the frontmatter. An unfinished intent is redone at startup, so a crash in between
  leaves the right ID, and the stale title is repaired.
- A dated note's slug comes from a slug field (`daily.date`) contributed by the Daily module.

## Consequences

Outside moves are detected by the ID inside the file (a `renamed` change), never treated as a
deletion and a creation.
