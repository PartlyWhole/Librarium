# Working on Librarium

Read these before changing anything:
- [SPEC.md](SPEC.md): what the app does
- [FORMAT.md](FORMAT.md): the files it reads and writes
- [ARCHITECTURE.md](ARCHITECTURE.md): where the code is

## Rules

- **Requests are GitHub issues** (`gh issue list`). Commits that finish one say `Fixes #N`.
- **Keep the three docs true.** When behaviour, the format or the layout changes, update
  SPEC.md, FORMAT.md or ARCHITECTURE.md in the same commit.
  - The docs describe the app as it is now. They never record history or progress; git does
    that.
- **The file format is a promise.** Existing libraries must keep working. Change FORMAT.md only by
  addition, and only with the user's agreement.
- **Keep the code small.**
  - No layers, registries or abstractions without a second use.
  - No tests for things you can see by running the app.
  - Delete code that stops being used.
- **Ask the user** about the data format, about deleting anything, and when the spec is silent on
  something they would notice. Otherwise decide, and say what you decided in the commit message.
- **Never delete user data** without the two-step confirmation (archive, then confirm).
- **Never touch files** outside the project folder, the user's library folder and the app's own
  folders.
- **Commit messages** are plain and explain why.
