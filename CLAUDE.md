# Working on Librarium (for AI sessions)

Read these first: `BRIEF.md` (what the app must be), `docs/DEVELOPING.md` (how the code is
organised, lessons learned), `docs/REQUESTS.md` (what the user is asking for).

## Requests: the user writes, you answer

At the start of a session, and whenever the user says "check requests", open
`docs/REQUESTS.md`:

1. **Inbox → In progress.** Give each new item the next number (`R-NNN`, after the highest in
   the file), keep the user's words as a quote, and move it to **In progress**.
2. **Only the user can decide?** Put a clear question under **Waiting for you** (options,
   trade-offs, your recommendation) and work on other items. Never guess at their decisions.
3. **When done, move it to Done (newest first)** with:
   - **Changed:** what is different, in plain words.
   - **Use:** how to use it (keys, menus).
   - **Code:** where it lives (paths).
   - **Commits**, **Decision** records, **Tested** (and what couldn't be tested, e.g. needs
     the real app).
   - **Left:** what wasn't done, or follow-ups (make new Waiting/Inbox items if needed).
4. Keep `docs/DEVELOPING.md`, the README decision table and `docs/decisions/` current, as
   for any change.

## Rules that always hold

- Ask the user only where the brief says to; otherwise decide and record the decision.
- Never weaken tests; when behaviour changes on purpose, update tests and say so.
- Never touch files outside the project folder, the user's library folder and the app's own
  folders. Never delete user data without the two-step confirmation.
- Commit messages are plain, explain why, and end with the co-author line given in the
  session.
- The user's app often runs from this working tree (`npm run dev`): Rust edits restart it.
- Verify interface changes in the preview (`npm run dev:mock`, port 1421); say plainly what
  only the real app can show.
