# 0049. A capture's parts are edited in place, by dragging; pictures are first-class parts

- Status: accepted
- Date: 2026-10-04
- Request: R-036 in `docs/REQUESTS.md`

## Context and problem

The user wanted to edit what a capture holds by dragging the boundaries of each passage, even in
a capture of several separate passages, with a first-class interface. Image captures had to be
as good, and it all had to work in PDFs, saved web articles and EPUBs.

## Decision

- **Where:** in the source, in edit mode. It starts from the capture page's Edit selection
  (pencil), or from Edit in a highlight's popover. The route's `edit` param starts it in the
  open document (0048).
- **The draft:** the "capture being made" draft holds the capture's parts, marked as editing.
  The side panel says "Editing", lists the parts (each removable), and has Cancel and Save
  changes. Selecting more text, or dragging a region, adds a part. The capture's saved highlight
  gives way to the parts being edited.
- **Readers** implement `editParts(parts, onChange)`:
  - **Text parts** get handles at both ends, as in Apple Books: start knob above, end knob below
    (`rangeEditor`). Ends snap to whole words, never cross, and keep a word. While dragging, the
    part is redrawn; when let go it is anchored again in the stored text, like a new selection
    (quote, position, page or CFI).
  - **Regions** get a frame with corner and edge handles to resize, and the inside to move
    (`regionEditor`). The picture is taken again at full sharpness when let go (PDF: rendered
    afresh; images: cropped from the original).
  - The handles live in the app's document, never in a book page or PDF text layer. A
    transparent shield keeps a drag over a book's frame. PDF parts are found from where they
    were drawn; EPUB parts from their CFI.
  - `caretIn` finds the character at a point. It uses the browser's hit test, and falls back
    to the nearest text on the line, because PDF.js's invisible text layer can't always be hit.
  - In zoomed EPUB pages, it hit-tests in the frame's pixels and measures in the page's units
    (R-035).
  - EPUB parts get handles in the chapter shown, and again after a page turn.
- **Saving** is `captures.update`:
  - it replaces the parts, the anchor's parts and the quote;
  - it keeps your words, and a title you gave (an automatic title follows the new quote);
  - it rewrites region images by position and never deletes any file. An image left over from
    a removed part stays, unreferenced.
- **Pictures:** clicking a picture in a book selects it, offering "Capture image". It's captured
  as an image part (its own pixels, with its CFI). Cards in notes show every part in order,
  pictures as pictures.
- The capture page's header has Edit selection, Copy embed, Export and Delete.

## Consequences

- Interface tests cover the flow end to end with a fake reader. A Rust test covers
  `captures.update`. WebKit checks drag real handles in a saved article (one very tall PDF
  page), an EPUB at 100% and 130%, and an image's recognised text, resize regions, and capture
  a book picture.
- A passage can't yet be dragged across an EPUB page turn. Extend it on the next page, or add a
  part there.
