# 0026. How Captures meets the reader and the editor

- Status: accepted
- Date: 2026-10-03

## Context and problem

Capturing happens in the Library's reader, embeds live in Notes' editor, and features may
not import each other (§4.3).

## Decision

- **`library.reader-tools`** (a slot hosted by Library, defined in `shell/slots.ts`): Captures
  adds its toolbar controls, given the item, its reader view and its stored text.
- **`place`:** the reader opens an item at a place given as W3C selectors in the route; the
  captures panel and embeds use it to show a capture in its source. Engines implement
  `showPlace` (page, quote, region, CFI).
- **`shell.embeds`:** how a record placed with `![[label|id]]` reads, in the editor and in
  "Export with quotations"; Captures fills it for its kind. `shell.editor-extensions` carries
  Captures' embed drawing.
- The note-editing session moved to `src/editor/session.ts`, so a capture's words are edited
  the same way.
- Pages and side-panel sections render untracked: a page subscribes to what it needs itself,
  and isn't re-rendered (and reset) by anything it happened to read.

## Consequences

`ReaderTool` and `EmbedRenderer` contributions appear in the architecture report.
