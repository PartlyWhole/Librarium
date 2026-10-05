# 0056. The capture being made is shown in the side panel; the reader keeps the page

- Status: accepted (refines 0031; follows 0049's editing in the side panel)
- Date: 2026-10-05
- Request: R-053 in `docs/REQUESTS.md`

## Context and problem

The capture being made (its parts, your words, Discard / Save) sat in an aside next to the
reader, which split the page in two. Editing a capture had already moved to the side panel
(R-038). The user asked for the book to keep the whole main view, with the capture's details
in the right side bar.

## Decision

- The panel is shown at the top of the side panel's **Captures** view, above that source's list
  of captures. Capturing on an item page opens the side panel to that view.
- The item page's own aside stays empty and hidden, so the reader keeps the page.
- The reader tool still builds the panel; it hands it to the Captures view through a signal
  (`draftShown`), keyed by source. A Captures view for another source doesn't show it.
- After Save or Discard, the panel goes and the side panel stays open, showing the list (with
  the new capture).

## Consequences

- Capture tests render the side panel's Captures view next to the tool and check that the
  reader's aside stays empty. A test on the item page checks that the real side panel opens
  with the panel in it.
