# 0070. A book's layout is one visible choice: single page, two pages or scroll

- Status: accepted (amends 0046)
- Date: 2026-10-06
- Request: R-066 in `docs/REQUESTS.md` (the user chose "Like Books, plus visible")

## Context and problem

Choosing how a book is laid out took two controls far apart (diagnosed in R-066):
- "Scrolling view", a switch under nine rows of fonts;
- "Pages: Two when wide / One", hidden under Customise, and hidden again while scrolling.

Two pages turned into one silently when the window was narrow. Switching from scrolling to
pages moved the reader about a page on. Scrolling had no side margins, and there was no menu
item or shortcut.

Apple Books on the Mac puts Single Page and Two Pages in the View menu and scrolling in its
appearance settings; on iOS the page style is in the top row of Themes & Settings.

## Decision

- **One setting, `layout`: `single`, `two` or `scroll`** (default `two`). Saved settings from
  before carry over: scrolling → `scroll`; one page → `single`; two when wide → `two`.
- **The Aa panel's top:** text size, then **Layout: Single page | Two pages | Scroll**. The font
  list becomes one row (a list in which each font is shown in its face), so the panel fits
  without scrolling. Customise keeps line spacing, line length and justify.
- **Two pages falls back to one when there isn't room** (Readium decides from the line length),
  and the panel says so: "Not enough room for two pages, so one is shown." The note follows the
  window as it is resized.
- **The View menu has Single Page (⌃⌘1), Two Pages (⌃⌘2) and Scrolling (⌃⌘3)**, available
  while an EPUB is shown, and in the command palette as "Book layout: …". ⌘1–9 are tabs and
  ⌥⌘1–6 headings, so the layouts take ⌃⌘.
- **Switching keeps the place:** the first word on screen is noted (as a CFI) before the change
  and shown after it. Readium alone keeps only the chapter's progression, which differs between
  pages and scrolling.
- **Scrolling has the same side margins as pages** (Readium's `scrollPaddingLeft/Right`, the
  page gutter), so its column is centred, with margins in a narrow window too.

## Consequences

- Scrolling, Readium goes to progression × the whole height (not the height less one screen,
  as for pages). Showing a place while scrolling landed past it; `progressionOf` now counts
  that way.
- The View menu items aren't ticked to show the layout in effect (the app's menu items have
  no ticks yet); the Aa panel shows it.
- WebKit checks: settings carried over; switching scroll → single → scroll → two keeps the
  first word on screen each time; two pages when wide, one when narrow with the note; single
  page in a wide window; scrolling margins, wide and narrow. Interface tests cover the panel's
  order, the migration, the preferences and the View menu.
