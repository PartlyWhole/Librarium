# 0069. EPUB footnotes show in a popover over the page

- Status: accepted
- Date: 2026-10-06
- Request: R-065 in `docs/REQUESTS.md` (the user chose "Popover", as Apple Books does)

## Context and problem

With links working (0068), a footnote took you to the note, and you came back with the book's
own back-link when it had one. You lost your page to read one sentence.

## Decision

- **A link that is a note reference opens the note in a popover** beside the number:
  - a note reference is a link marked `epub:type="noteref"` or `role="doc-noteref"`, or a link
    whose text is a short mark (`1`, `[12]`, `(3)`, `*`, `†`, `a`);
  - the note is found where the link points: in a page already shown, else read from the book
    (`readAsXML`), so notes files in other parts of the book work too;
  - an empty anchor (`<a id="n3"/>`, as in *Either/Or*) stands for its paragraph;
  - the note's words keep simple formatting (emphasis, small caps, line breaks); its back-link
    and leading number punctuation are left out.
- **The popover has "Go to note" and "Close";** Escape and a click elsewhere close it. It uses
  the book's theme colours.
- **Anything that doesn't look like a note goes to its place, as before (0068):** links that
  aren't note references; notes that are empty, contain the reference itself, or are longer
  than 3000 characters (too much for a popover).

## Consequences

- You keep your page; "Go to note" still goes there when you want the context.
- A book that marks nothing and uses words for its note links ("see note") goes to the note.
- WebKit checks with real clicks cover: a note at the end of the chapter, a note in a separate
  file (closed with Escape), an empty anchor in a non-linear file with a space in its name, Go to
  note and back, and a long link going to its place.
