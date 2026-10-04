# Plan: first-class writing, and version history

Status: in progress (2026-10-03). Each phase lands as its own commit, with tests and a
decision record; this file is updated as phases finish (✅).

The user's decisions (2026-10-03):

- History lives in a hidden `.librarium/` folder inside the library.
- "Delete permanently" also erases a note's history.
- Retention: every version for a day, hourly for a week, daily for three months, then weekly.

Background research (2026-10-03) compared Obsidian's editor and its history options
(File recovery, Sync, the Git plugin) with Librarium; the gap list and the options are
summarised below where they shaped the plan.

---

## Part 1. The editor

The editor is CodeMirror 6 (`src/editor/`): `editor.ts` builds it, `livepreview.ts` hides
Markdown syntax, `links.ts` parses `[[label|id]]` (shared fixture with the Rust parser),
`complete.ts` completes `[[`, `markdown.ts` adds `==highlight==`, `session.ts` saves.

### E1. Live preview that feels right ✅

- **Reveal per element, not per line.** With wrapping, a "line" is a paragraph: today every
  mark in it shows while the cursor is anywhere in it. Reveal a construct's marks only while a
  selection touches that construct (Emphasis, StrongEmphasis, Strikethrough, Highlight,
  InlineCode, Link, Image, a heading's line, a quote's line).
- **Never show a link's ID.** In a revealed `[[label|id]]`, the `|id` tail is replaced by
  nothing and is atomic (the cursor skips it; Backspace removes it whole), so one edits
  `[[label]]` only.
- **Stop hiding text that isn't markup.** Bare URLs and `<autolinks>` stay (styled as links);
  `[words]` that aren't links (`[sic]`, `[!note]`, `[^1]`) keep their brackets; reference
  definitions stay; images show `alt` with an image marker.
- **Markdown links `[text](url)`** are styled and clickable (⌘-click or click when not
  editing), through the link dialog (decision 0036).
- **Dim revealed marks** (faint colour), so the text stays the focus.
- Tests: decorations computed on fixture documents (jsdom), per construct.

### E2. Formatting and selection ✅

- Commands, in the editor keymap and in a new **Format** menu (native menu and palette):
  bold ⌘B, italic ⌘I, strikethrough ⇧⌘X, highlight ⇧⌘H, inline code ⌘E, link ⌘K (wraps the
  selection as `[sel]()` with the cursor in the parentheses; with nothing selected, opens
  `[[`), task toggle ⌘L, headings ⌥⌘1–6, body text ⌥⌘0. Toggles unwrap when already applied
  (read from the syntax tree).
- **Typing `*` `_` `=` `` ` `` `~` with text selected wraps it** (no auto-pairing on an empty
  selection, which would fight list markers).
- **Multiple cursors:** `allowMultipleSelections`, ⌘D adds the next match (CodeMirror's
  `selectNextOccurrence`), ⌥-drag rectangular selection, ⌥-click adds a cursor.
- Tests: each command on fixtures (toggle on, toggle off, multi-range).

### E3. Lists ✅

- Tab / ⇧Tab on a list item move it **with its children**, by the width of the parent's
  marker (so `1.` children align); ordered lists renumber after indent, outdent, Enter and
  deletion.
- ⌘L toggles `- [ ]` / `- [x]` (and makes a line a task).
- Bullets show as a dot (•) when not being edited; wrapped lines of a list item hang under its
  text.
- Tests: indent/outdent subtrees, renumbering, task toggling.

### E4. Paste ✅ when done

- **HTML pastes as Markdown** (headings, paragraphs, emphasis, links, lists, quotes, code,
  tables, images as their alt text and address), converted by our own small converter over
  `DOMParser` (no scripts run; nothing is fetched). ⌥⇧⌘V pastes plain text.
- Copying out of the editor puts `[[label]]`, not `[[label|id]]`, in the plain-text
  clipboard (the full form stays for pasting inside the app).
- Tests: converter fixtures; copy filter.

### E5. Structure and code ✅ when done

- **Folding** by heading and by list/quote/code block: a fold gutter shown on hover, and
  ⌥⌘[ / ⌥⌘] (fold, unfold), ⌃⌥⌘[ / ⌃⌥⌘] (fold all, unfold all). Fold state is per device
  (never written to the file).
- **Code blocks are highlighted** by language (a small built-in set loaded lazily: JS/TS,
  Python, Rust, JSON, CSS, HTML, shell, SQL, Markdown), with a theme from the app's colours.
- Tests: fold commands; highlighting present for a fenced block.

### E6. Writing comfort ✅ when done

- **Word and character count** for the open note (and for the selection when there is one),
  in the status bar.
- **Outline**: a side-panel section listing the note's headings; a click scrolls there.
- **Unresolved links**: clicking `[[New idea]]` (no ID) offers to make the note, then links
  it.
- **Custom link text survives renames**: the link-repair job refreshes a label only when it
  equals the target's *old* title (so `[[see Smith|id]]` stays). Decision 0020 is amended.
- Tests: counts, outline, creating from an unresolved link, the repair rule (Rust).

Later (not in this plan): hover previews, callouts, `#tags`, images in notes (needs a
decision: library items vs an attachments folder), tables editor, properties editor,
templates and slash commands, math, focus mode.

---

## Part 2. Version history

### Shape (decision 0038 when done)

- **Kernel module `history`** (`crates/kernel/src/history.rs`), working through the
  `FileSystem` port (so the test file system and the crash sweeps apply). The old
  `VersionStore` port stays as an optional mirror hook (e.g. a future git mirror) and is not
  used for this.
- **On disk, in the library:** `.librarium/history/`
  - `objects/<2 hex>/<sha256>`: a version's bytes, exactly as the file was; written once,
    never changed (safe with iCloud).
  - `log/<device>.jsonl`: one line per version, written only by this Mac
    (`{"id","kind","path","title","hash","ms","origin"}`, origin = `app`, `outside`,
    `restore`), plus `{"forget": id, "ms"}` lines. Other Macs' logs are read, never written.
  - `README.txt` says what this is and how to read it without the app.
  - The device's name is a random ID kept in Application Support (`device.json`).
- **What is kept:** Markdown records (notes, daily notes, captures). Library items' files are
  originals and dated snapshots already, so they need no history.
- **When a version is taken:**
  - after the app writes a record, at most once per 5 minutes per record (the latest text is
    taken at the next maintenance tick once 5 minutes have passed);
  - always when a record changes outside the app, and before a restore (so a restore can be
    undone);
  - never twice for the same bytes.
- **Retention** (pruning at maintenance, at most once a day): everything for 24 hours; then
  the last version of each hour for 7 days; of each day for 90 days; of each week after that.
  This Mac prunes only its own log; an object is removed only when no log of any Mac refers to
  it.
- **Deleted outside the app** (Finder, sync): the record's history stays and it is listed
  under "Recently deleted" (restore puts it back at its path, with its ID).
- **Delete permanently** erases the record's history: its lines leave this Mac's log, a
  `forget` line hides it from other Macs' logs, and its objects go once nothing refers to
  them.
- **The index** (record → versions) is rebuilt in memory from the logs at open; it is derived
  data.

### API and interface

- `history.versions {id}` → versions, newest first (time, origin, size, words).
- `history.read {id, hash}` → the text; `history.diff {id, hash}` → line changes against the
  current text (computed with `similar`).
- `history.restore {id, hash, base_version}` → takes a version of the current text first,
  then writes the old text as a normal save.
- `history.deleted {}` and `history.restoreDeleted {id}`.
- **Interface:** a "History" side-panel section for an open note: versions grouped by day,
  each with its time and what happened (edited here, changed outside the app, restored); a
  click opens a comparison (removed and added lines) with Restore. "Show history" (⌥⌘Y) in
  the File menu. The Archive page gets "Recently deleted".
- Tests: kernel (coalescing, outside edits, dedup, retention buckets, forget, two devices,
  missing objects), a crash sweep for restore, API, interface.

---

## Order of work

1. This plan and the developer guide (`docs/DEVELOPING.md`) — what exists, where, why.
2. E1 → E6, a commit each.
3. History: kernel and API, then the interface.
4. Decision records 0037 (editor) and 0038 (history); README table; this file marked done.
