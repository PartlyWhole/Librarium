# 0058. Indentation is indentation, not code

- Status: accepted (the user chose it, 2026-10-05, R-059)
- Date: 2026-10-05

## Context and problem

The user indents lines with Tab, including captures (`![[…]]`) and links. In CommonMark a line
indented by four spaces or a tab is an indented code block, so an indented capture turned
into monospace text and stopped being a capture or link, in the editor and in the kernel
(backlinks, "used by"). Even when it stayed a capture, its box filled the line and ignored
the indentation.

## Options considered

1. **Indent is indent** (chosen): leading tabs and spaces only indent; code is fenced
   (```` ``` ````) or inline. Other Markdown apps (Obsidian, GitHub) still show such lines as code.
2. **Stay standard:** keep indented code; Tab on a capture or link line makes it a list item,
   which indents in every app but brings a bullet.

## Decision

- Both link parsers treat indented lines as ordinary text: the editor's Lezer parser without
  `IndentedCode` (`NoIndentedCode` in `src/editor/links.ts`, used by the editor's Markdown
  too); the kernel's `code_ranges` parses the text with each line's leading whitespace
  removed and maps ranges back (pulldown-cmark can't turn indented code off). Shared fixture
  cases cover it.
- Tab on a line that isn't a list item inserts a tab (`indentUnit` is `\t`); ⇧Tab removes one;
  Enter keeps the line's indentation. List items keep their own Tab (0037).
- `src/editor/indent.ts`: away from the cursor a line's leading whitespace is hidden and the
  line gets a left margin of the same width (a tab is four monospace columns), so text,
  quotes and captures move right and wrapped lines stay aligned. On the line being edited
  the whitespace shows as typed, in monospace, at the same width. Fenced code, HTML and
  tables keep their whitespace.

## Consequences

- Notes with indented lines read as code in other Markdown apps. Older notes using four-space
  code blocks now show as indented text in Librarium; fences still work.
- Amends §5.4 of the brief: "code blocks" there means fenced blocks.
