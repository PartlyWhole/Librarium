# 0017. How notes are edited, saved and recovered

- Status: accepted
- Date: 2026-10-02

## Context and problem

§6 fixes the timings (a draft about 300 ms after a change, a save after 1 s idle, and on blur,
navigation and window close) and the rules (three-way merge, never overwrite silently). A few
details were open.

## Decision

- The Today page opens today's note directly (creating it if missing), so ⌘T is one step.
- A recovered draft is loaded into the editor with a notice offering to discard it; the
  normal autosave then saves it (merging if the file changed since the draft's base).
- If typing continues while a merge is saved, the next save merges again from the old base,
  so outside edits are never lost.
- A conflict dialog shows both versions and offers: keep yours, use the version on disk, or
  keep both (yours becomes a new note "<title> (your version)").
- Renames and moves record an inverse that carries the version they produced; undo refuses if
  the file changed since. The toast offers Undo; the palette and Edit menu offer it too.
- Keystroke-to-paint is measured in the editor (beforeinput to the next frame) and logged
  every 100 keystrokes.

## Consequences

Text undo stays CodeMirror's; app-action undo is separate, as §6 says.
