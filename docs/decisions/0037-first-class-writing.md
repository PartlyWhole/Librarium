# 0037. First-class writing in the editor

- Status: accepted
- Date: 2026-10-03
- Amends: [0020](0020-link-repair.md) (which link labels follow a rename)

## Context and problem

The user wants writing to be first class, as in Obsidian. A comparison (in
`docs/plans/editor-and-history.md`) found several gaps:

- Live preview showed every mark of a paragraph as soon as the cursor was anywhere in it,
  link IDs included.
- Some text that isn't markup vanished: bare addresses, `[sic]`, footnote marks.
- There were no formatting commands, multiple cursors were disabled, and lists didn't move
  with their children.
- Pasting HTML flattened it.
- There was no folding, code highlighting, word count or outline.
- Renaming a note overwrote link text written in one's own words.

## Decision

- **Live preview, per construct** (`livepreview.ts`).
  - A construct's marks show (dimmed) only while a selection touches that construct.
  - A link being edited reads `[[label]]`: its `|id` is hidden and is an atomic range.
  - **Never hidden:**
    - bare URLs and autolinks (styled as links);
    - `[…]` that isn't a link (no URL and no reference label);
    - reference definitions.
  - **Markdown links** show their words and open through the link dialog (0036) on a click,
    unless being edited; ⌘-click always opens.
  - Images show their alt text.
  - Bullets show as dots; a task's bullet gives way to its checkbox.
- **Formatting** (`format.ts`):
  - **Keys:** ⌘B bold, ⌘I italic, ⇧⌘X strikethrough, ⇧⌘H highlight, ⌘E code, ⌘K link, ⌘L
    task, ⌥⌘1–6 headings, ⌥⌘0 body text.
  - **Toggles:** a toggle is recognised from the syntax tree anywhere inside the construct,
    and acts on every selection.
  - **Menu:** a native Format menu and the palette run them on the editor last used. Their
    keys aren't reserved, so in the editor CodeMirror handles them, and ⌘L overrides
    CodeMirror's "select line".
  - **Wrapping:** typing `* _ = \` ~` with text selected wraps it. There is no auto-pairing on
    an empty selection, which would fight list markers.
  - **Multiple cursors:** `allowMultipleSelections`, ⌘D adds the next match, ⌥-click adds a
    cursor, and ⌥-drag makes a rectangular selection.
- **Lists** (`lists.ts`):
  - Tab and ⇧Tab move an item with its subtree, by the parent's marker width.
  - Numbered lists are renumbered: a nested list starts at 1, and a top-level list keeps its
    first number.
  - Wrapped lines hang under the item's text. The item's indentation and marker are set in
    the monospace font (`.cm-list-prefix`), whose character width is measured once, so the
    hang is exact in em at every level. An inline-block bullet must reset `text-indent`, or it
    inherits the line's negative indent and drifts left.
- **Clipboard** (`clipboard.ts`, `html2md.ts`):
  - **HTML → Markdown:** HTML with structure pastes as Markdown, by our own converter over an
    inert `DOMParser` document. No dependency was added, and nothing runs or loads. A code
    editor's HTML (`white-space: pre`) stays plain text.
  - **Plain paste:** ⇧⌥⌘V pastes plain text.
  - **Copying out:** copying gives `[[label]]` to other apps and keeps the exact text in a
    private clipboard type for pasting back into the app.
- **Code and folding** (`code.ts`):
  - Fenced blocks are highlighted (`classHighlighter`, styled only inside code blocks) for
    JS/TS, Python, Rust, JSON, CSS, HTML, SQL and shell. Each language package is loaded
    lazily and pinned.
  - Folding has a gutter in the margin, shown on hover, and CodeMirror's fold keys. Fold
    state stays in the editor and is never written to the file.
- **Comfort** (`stats.ts`):
  - **Counts:** words and characters (or of the selection) appear in the status bar, through a
    new `shell.status.context` that each tab's shown page sets.
  - **Outline:** a side-panel section; a click goes to the heading.
  - **Unresolved links:** clicking one makes the note beside the current one (as in
    Obsidian), completes the link and opens the note.
- **Aliases survive renames** (amends 0020).
  - The `links.repair` trigger now passes the target's old title.
  - A link's label is refreshed only when it equals that old title, so a label in one's own
    words stays.
  - When the old title is unknown (a record first seen since the app started), no labels are
    refreshed.

## Consequences

- **Clicking a link's words opens it rather than placing the cursor.** Edit the words from
  the keyboard, or by clicking beside them.
- **Not yet done:** hover previews, callouts, tags, images in notes (this needs a decision:
  library items or an attachments folder), a table editor, a properties editor, templates,
  slash commands, math and focus mode.
