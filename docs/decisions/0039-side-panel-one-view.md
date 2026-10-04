# 0039. The side panel shows one view at a time

- Status: accepted
- Date: 2026-10-03
- Request: R-024 in `docs/REQUESTS.md`

## Context and problem

The side panel stacked every section that applied (Linked from, Links without a target,
Outline, History, Jobs…) in one long column. Jobs filled it with every finished "Refreshing
link labels". The user disliked it. Of the options, the user chose to keep a right panel that
shows one view at a time, as Obsidian's right sidebar does.

## Decision

- **Icons along the panel's top** (a WAI-ARIA tab list, moved through with the arrow keys)
  choose the view. Only views that apply to the page shown are offered.
- **The choice is remembered** (`ui.panelView`). If it doesn't apply here, the panel shows the
  first view that does.
- **A section gives its icon** (`SidePanelSection.icon`). The views:
  - Links: backlinks, plus a note's links without a target, in one view.
  - Outline and History, for notes.
  - Captures and About, for library items.
  - Jobs.
- **`shell.showPanelSection(id)` opens the panel on that view.** It is used by ⌥⌘Y for History
  and by the status bar's jobs button.
- **The panel starts closed,** as before.
- **Repeated finished jobs** are grouped in Recent ("Refreshing link labels · 12 times, last
  at 11:24 PM").

## Consequences

- To see two views, switch between them; nothing is stacked.
