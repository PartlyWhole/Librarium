# 0020. When link labels are refreshed and missing IDs restored

- Status: accepted; amended by [0037](0037-first-class-writing.md) (only labels equal to the old title follow a rename)
- Date: 2026-10-02

## Context and problem

A label is a cache of the target's title, refreshed by a repair job (§5.4, §4.2). Repairs
write to the user's files, so they must be careful.

## Decision

The `links.repair` job, triggered by a change to a record:

- refreshes labels of plain links (not embeds, whose label is the quotation's first words) to
  that record, only when its title changed;
- restores a missing ID only when exactly one record has the label's title — in that
  record's own unresolved links, and in links elsewhere that the new title resolves;
- writes through the writer's background lane with a version check, only when the folder is
  quiet, and never into a note that has unsaved text (a draft); if it can't, it leaves the
  cache stale, which is never an error.

Unresolved links are listed in the side panel, where the user can choose a target
(`links.resolve`).

## Consequences

An editor open on a note whose links were refreshed reloads it, as it does for any change it
didn't make itself.
