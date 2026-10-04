# 0046. Reading books looks and feels like Apple Books

- Status: accepted
- Date: 2026-10-04
- Request: R-030 in `docs/REQUESTS.md`

## Context and problem

The user asked for the book reader's interface to be "more like apple books". Books keeps
chrome out of the way:
- the toolbar shows on approach;
- a quiet running head and page line;
- arrows at the edges and trackpad swipes;
- an Aa popover with size, theme swatches, fonts, scrolling and "Customise";
- contents as a popover.

## Decision

- Readers can ask for **immersive** chrome (`ReaderView.immersive`). The library page then
  floats its toolbar over the reader and shows it while the pointer is within 64 px of the top,
  while something in it has focus, during a find, or while the reader asks (`onChromeWanted`, a
  popover is open). Book frames swallow mouse events, so the reader reports the pointer
  (`onPointer`). Zoom buttons are hidden for immersive readers.
- Readers can add their **own toolbar controls** (`ReaderView.controls`): the book adds Contents
  at the start and Aa before Find.
- The book shows:
  - a running head with the chapter's name;
  - a page line with "N pages left in chapter" (from the layout: columns across the frame)
    and the percentage through the book;
  - arrows at the sides that show while the pointer moves.
  The page's colour fills the whole reading area. Margins are roomier.
- One trackpad swipe turns one page (in page view). The arrows, swipes and ← → follow the
  page's visual direction, so right-to-left books turn the right way.
- The Aa panel follows Books:
  - smaller and larger A;
  - White, Sepia, Gray and Night swatches, and "Match the app's appearance";
  - the macOS book fonts, each shown in its own face (Original, Athelas, Charter, Georgia,
    Iowan, Palatino, San Francisco, Seravek, Times New Roman);
  - Scrolling view;
  - under Customise: line spacing, line length, one or two pages, justify.
  Settings from the first version are carried over.

## Later: margins at any text size (R-032)

Readium sizes text with CSS `zoom` on the page body, which scales the margins with it, and
measures line length in characters. So larger text ate the margins and could jump from two
columns to one wide one. As in Books, the page keeps its margins and columns and fewer words
fit a line:
- the page margin and scroll padding are divided by the text size;
- above 100%, so are the line lengths (below it, Readium compensates itself).
A WebKit check in a wide window keeps the on-screen margin, the text width and the column count
the same at 130%. It fails without the fix.

## Consequences

- WebKit checks cover immersive chrome, the arrows, the contents popover marking where you are,
  the Night theme, and pages left in the chapter.
- How the toolbar's approach and the swipes feel can only be judged in the real app.
