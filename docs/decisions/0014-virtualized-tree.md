# 0014. The sidebar tree is virtualized

- Status: accepted
- Date: 2026-10-02

## Context and problem

With 10,000 notes, rendering every sidebar row took about 3.9 s in tests, which breaks the
1.5 s cold-start budget.

## Decision

The tree keeps the APG tree pattern with flat `treeitem`s carrying `aria-level`,
`aria-setsize` and `aria-posinset` (a form the APG allows), and renders only the rows in view,
plus the focused row. Rows are a fixed 26 px.

## Consequences

The interface starts with 10,000 notes in about 110 ms in tests. Rows can't vary in height.
