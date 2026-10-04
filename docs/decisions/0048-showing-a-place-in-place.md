# 0048. Showing a place moves the open document there

- Status: accepted
- Date: 2026-10-04
- Request: R-034 in `docs/REQUESTS.md`

## Context and problem

"Show in the source" was slow and unreliable:
- any change to a route's params made the shell render the page again, which reopened the
  whole document;
- asking for the same place twice was ignored;
- PDFs went to the top of the capture's page and searched for its quote, which misses (very tall
  saved pages, ligatures, other occurrences).

## Decision

- A page may return a handle `{ dispose, update }`. When the route stays on the same record (its
  place in the tab, `placeOf`) but its params change, or it is asked for `again`, the shell calls
  `update(params)` instead of rendering again. If that returns false, the page is rendered
  afresh. The item page moves the open reader (`showPlace`, `goToTextOffset`); another snapshot
  needs a fresh page. The tab keeps its title.
- `router.go(..., { again: true })` and `shell.openRecord(..., { again: true })` ask for a route
  even if it is already shown. Every "Show in the source" uses it.
- A capture's place for the reader carries where each part was drawn: a `librarium:boxes`
  selector, only in the route and never stored. The PDF reader goes to that page and outlines
  the box around the part, and searches for the quote only without boxes.

## Consequences

- Showing a capture is instant in an open document and works every time.
- Other pages keep rendering afresh on new params until they offer `update`.
