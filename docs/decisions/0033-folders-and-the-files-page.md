# 0033. Folders for notes and library items, browsed as in Finder

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

## Addendum: arranging by hand (positional dragging)

- **Where the arrangement is kept:** `.librarium/order.json` in the library. It is the
  user's organisation, so it travels with the library and is not a per-device preference.
  It holds `{ folder: [entry, …] }`, the top level as `""`. An entry is a record's ID, which
  survives renames and moves, or `folder:<name>`. Entries not listed come after, in the
  usual order. Losing the file loses only the arrangement.
- **It follows folders:** a folder move or rename updates it inside the same intent.
  Renamed in place, a folder keeps its spot; moved elsewhere, it leaves its old spot.
  Removing a folder removes its arrangement.
- **Dropping:**
  - On the top or bottom edge of a row (left or right in icons), things go before or after
    it, and a line shows where.
  - In the middle of a folder, they go into it.
  - Things from another folder are moved here first, then placed.
- **The sort:** the first placement switches to "As arranged", taking the order shown as its
  start. "As arranged" is in the Sort menu, and any other sort goes back. Placing offers
  Undo. The sidebar's folder tree shows the same order.
- **Keyboard:** ⌥↑/⌥↓ (⌥←/⌥→ in icons) move the selection one place.
- **Drop targets:** a drop target can say where in itself a drop goes (`where`), or refuse
  and let what is around it take the drop.

## Addendum: each kind has its own folders; no Files page

Having used it, the user preferred a Notes panel with its own folders and a Library panel
with its own, and no separate Folders or Captures sections. Captures belong to the items they
come from.

- **Folders belong to one kind.**
  - A notes folder is only `notes/<path>/`, and a library folder only `items/<path>/`. The same
    name in each is two folders.
  - Every folder call takes a `kind`.
  - The `move-folder` intent carries its kind.
  - `.librarium/order.json` keeps one arrangement per kind's top folder
    (`{ "notes": {…}, "items": {…} }`).
- **The browser lives in the shell** (`src/shell/folders/`), as a service, `shell.folders`.
  - A feature adds its kind as a folder space: page, title, header buttons, records shown
    elsewhere, and what a record holds.
  - The space gets its page (the Finder-like browser) and its sidebar tree.
  - Notes and Library are such spaces. Their pages ("notes", "library") are now the browser,
    and the Files page is gone.
  - Daily notes stay in their own group. A space can have groups (`groups()`), shown first
    at its top level and opening like a folder (`{ group }`), so the Notes page shows
    "Daily notes" rather than looking empty. Nothing is dragged into or arranged in a group:
    what it shows is decided by the records themselves.
- **The sidebar has two trees,** Notes and Library: folders and records, arranged as on their
  pages. A section's heading takes drops onto its top level.
- **Captures show under their item** through a Library-hosted slot, `library.item-children`.
  An item's captures start folded: tree rows can start folded (`startCollapsed`), which is
  remembered once unfolded. A click on the item opens it; its arrow unfolds it.
- **The Library page's select mode** is replaced by the browser's own selection. A click
  selects and a double-click opens, ⌘A selects all, and Escape clears. A bar below shows the
  selection's actions as buttons ("Move 4 items to…", "Archive 4 items"). The Archive page
  keeps its select mode.
- **"Move to folder…"** is a shell record action for records of one kind at a time. It is not
  offered for archived records.

## Consequences

- **Finder and Librarium show the same folders.** A folder made in Finder appears when the
  window regains focus.
- **Moving an item renames its folder on disk.** Snapshots and captures follow it: captures
  point to their source by ID, never by path.
- **Notes' "Move note to folder…" now lists every folder,** not only those holding notes.
- **The page renders every entry of a folder** (no virtual list). That is fine for hundreds
  of entries; a folder of many thousands would want one.
