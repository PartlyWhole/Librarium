# 0033. Folders across notes and library items, and the Files page

- Status: accepted
- Date: 2026-10-03

## Context and problem

The user asked for folder organisation and navigation "as helpful as Finder or Google
Drive". Notes could already live in subfolders (0011), but library items (316 saved pages)
sat flat in `items/`, and there was no place to browse, make, rename or move folders.

## Options considered

1. **A folder field on each record** (a virtual folder). Files stay where they are. But Finder
   would show nothing of it, and notes already use real folders: two ideas of "folder".
2. **Real subfolders for every kind that has them, one tree to the user.** `Reading/Plato` is
   `notes/Reading/Plato/` and `items/Reading/Plato/`. Finder shows the same organisation.
3. One top folder for all user material. That would break the layout of BRIEF §5.1.

## Decision

Option 2.

- **Which kinds:** a kind is kept in folders when it names a subfolder field. That is notes
  (`notes.folder`) and now library items (`library.folder`, mirrored into `record.json`).
  Captures stay with their sources.
- **The path is the truth** (0011). A folder exists while a directory does, so empty folders
  are kept. A new folder is made in each kind's top folder. Folders a record path implies
  count too.
- **A folder record lives at `items/<folder>/<id>-slug/record.json`.** The startup scan
  descends into folders until it meets a `record.json`. A directory named like an ID is
  never taken for a user's folder.
- **Kernel operations** (`folders.list`, `folders.create`, `folders.move`, `folders.remove`,
  `records.move`):
  - **Moving or renaming a folder is one intent (`move-folder`).** The directories are
    renamed, so other files inside go along. Then each record's path, and its subfolder
    field, follow. Redone at startup if unfinished; a power-cut sweep proves the move is
    all or nothing.
  - **A move never merges** into a folder that already exists, and a folder can't go inside
    itself.
  - **A folder is removed only when empty.** No records may remain, archived ones included,
    and no other files. The system's `.DS_Store` doesn't count.
  - **Moving records into a folder** is one relocate intent per record.
  - The names are `folders.*`, apart from the `folder.*` calls about the library folder
    itself (0010).
- **The Files page** (⇧⌘E, ribbon):
  - **Layout:** one folder at a time, as a list (Name, Kind, Added; click a header to sort) or
    as icons. Folders come first.
  - **Navigation:** a path to click; ⌘↑ goes up and lands on the folder one came from.
  - **Selection:** a click selects, and ⌘-click and ⇧-click select several. A box drawn on the
    background selects too, and ⌘A selects all. A double-click or Return opens.
  - **Keyboard:** arrow keys move, also across the icon grid. Typing jumps to a name.
  - **Rename:** F2, in place. A new folder (⇧⌘N) is named in place as in Finder.
  - **Context menus:** on items, on folders, and on the background.
  - **Filter:** a filter field for the folder.
  - **Archived items** are hidden, and so is a folder holding only archived items.
- **The sidebar** gets a Folders tree. A folder opens on click and folds only from its arrow.
- **Drag to move:**
  - **From:** the list, or the sidebar's rows (notes and items alike).
  - **Onto:** a folder in the list, a part of the path, a folder in the sidebar, or the list's
    background.
  - **Undo:** every move, rename and removal offers Undo.
- **Pointer dragging, not the platform's drag and drop:** Tauri claims every drag over the
  window so that files from Finder can be dropped (its handler always says it took the drag).
  The page's own HTML drag and drop would then never be dropped. `kit/dnd.ts` drives drags
  with pointer events, hit-tests drop targets, scrolls lists near their edges, and cancels
  on Escape.
- **"Where new things go":** the shell's `here` signal holds the folder being looked at.
  New notes (⌘N), files added, and web pages saved go into it. A page saved again keeps its
  item where it is.
- **Records' menus** offer "Move to folder…", and the File menu offers "Move to folder…" and
  "Show in its folder" for an open note or item. The folder picker lists every folder and
  makes a new one from a typed path.
- **Kinds' looks:** a new shell slot, `shell.record-looks`, gives each kind's icon, kind name
  ("Web page", "PDF", "Note") and detail line (a page's site, a PDF's page count).

## Consequences

- **Finder and Librarium show the same folders.** A folder made in Finder appears when the
  window regains focus.
- **Moving an item renames its folder on disk.** Snapshots and captures follow it: captures
  point to their source by ID, never by path.
- **Notes' "Move note to folder…" now lists every folder,** not only those holding notes.
- **The page renders every entry of a folder** (no virtual list). That is fine for hundreds
  of entries; a folder of many thousands would want one.
