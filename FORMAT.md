# Librarium file format

The library folder is the user's, and it is the only source of truth. Everything here must be
read and written exactly as described, because existing libraries depend on it. Anything not
described here (indexes, caches) is disposable.

## Conventions

- **IDs.** UUID v7, canonical: 36 characters, lowercase hex, hyphens at offsets 8, 13, 18 and 23.
  Uppercase or short forms are *damaged*. Identity comes from the ID inside a file, never from
  its name or path.
- **Timestamps.** `YYYY-MM-DDTHH:MM:SSZ` (UTC, whole seconds). Snapshot folder names use the
  compact form `YYYY-MM-DDTHHMMSSZ`.
- **Version of a file.** The lowercase hex SHA-256 of its bytes.
- **JSON written by the app.** Pretty-printed with a 2-space indent and object keys sorted by
  byte order. Non-ASCII is written literally and `/` is not escaped. A rewrite re-sorts the keys.
  - A trailing `\n` is added to `record.json`, `library.json`, `order.json` and `settings.json`.
  - No trailing newline is added to `.anchor.json`, `text.json` or `text-v1.json`.
- **Safe writes.**
  1. Write `.<name>.librarium-tmp-<pid>-<n>` in the same folder.
  2. `fsync` it (`F_FULLFSYNC`).
  3. Rename it over the target, or rename exclusively for new files.
  4. `fsync` the folder.

  Leftover temp files are removed at startup. A file without write permission is never replaced.
- **Unknown things are kept.** Unknown keys, unknown kinds and unknown files are never dropped or
  rewritten.

## Layout

```
<library>/
  notes/[<folders>/]<id>[-<slug>].md            note, or board (by `kind`)
  notes/[<folders>/]<id>.excalidraw             a board's drawing, beside its .md
  captures/<id>.md                              capture (never slugged, no subfolders)
  captures/<id>.anchor.json                     where the capture points
  captures/<id>.region-<N>.png                  picture of part N (1-based)
  items/[<folders>/]<id>[-<slug>]/record.json   library item
      original.<ext>                            imported file, byte for byte
      extracted/text-v1.json                    extracted / recognised text
      snapshots/<YYYY-MM-DDTHHMMSSZ>/page.pdf   saved web page
      snapshots/<YYYY-MM-DDTHHMMSSZ>/text.json
  .librarium/
    library.json    {"created": "<iso>", "id": "<uuid>"}
    lock            "<pid>\n" while open; present at open = unclean shutdown
    .gitignore      "lock\n" (created only if absent)
    order.json      manual arrangement
    history/        version history
```

### Folders and names

- **Folders.** User folders exist only under `notes/` and `items/`, as plain directories. Empty
  ones count.
  - A folder name may not:
    - be empty, or have leading or trailing spaces
    - start with `.`
    - contain `\`, `:` or control characters
    - exceed 200 bytes
    - start with a canonical UUID
  - `.DS_Store` and `.localized` are ignored.
  - `items/Attachments/` is an ordinary folder, created on first use.
- **The path wins.** `notes.folder` / `library.folder` mirror the subfolder (`/`-separated, absent
  at the top level). They are rewritten when the record moves.
- **Walking.**
  - In `notes/` and `captures/`: every `*.md`, recursively, skipping dot-entries.
  - In `items/`: every non-dot directory containing `record.json` is an item. Other directories
    are folders.
  - Everything else is ignored.
  - A `.md` in `notes/` with no `kind` is a note.
- **File names.** `<id>-<slug>.md`, or `<id>.md` when the slug is empty. Captures are always
  `<id>.md`. Items are `<id>-<slug>/`.
- **Slug.**
  1. Decompose to NFD and drop combining marks.
  2. Lowercase each run of alphanumerics and join the runs with `-`, with no leading or trailing
     `-`.
  3. Stop as soon as the slug is 60 characters or longer, even in the middle of a word. A `-`
     and the character after it are added together, so a slug can be 61 characters long.
  4. Recompose to NFC.

  `"  Éthique — et  Technique! "` → `ethique-et-technique`; CJK is kept; `"???"` → `""`.
- **Slug source.** `daily.date` if present, otherwise the title.
- **Rename or move.** Rename the file or folder first, then rewrite `title` and the folder field.
  Sidecars (`<id>.<suffix>` beside a Markdown record) move with it, before it.
- **Titles.** Lines are trimmed, empty lines dropped, and the rest joined with one space.

## The envelope

Reserved keys: `id`, `kind`, `kind-version`, `created`, `title`, `copied-from`. All other keys are
`<module>.<name>` and only ever gain meaning by addition. `kind-version` is `1` for every kind.

| key | rule |
|---|---|
| `id` | required; missing or damaged → repaired (see Repairs) |
| `kind` | `note` · `board` · `capture` · `item`; defaults to the folder's kind |
| `kind-version` | default 1; higher than known → read-only |
| `created` | timestamp |
| `title` | if absent in Markdown: the first `# ` heading |
| `copied-from` | the original's ID, written when a copy gets a new ID |

A record is **read-only** when its frontmatter doesn't parse, its `kind-version` is newer than
the app knows, or its kind is unknown. It is shown, but never rewritten.

## Frontmatter (Markdown records)

- **Block.** The first line is `---` (`\r` allowed). The block ends at the first `---` or `...`
  line, and a rewrite always closes it with `---`. A file containing any `\r\n` keeps CRLF.
- **Reading.** Any YAML 1.2, core schema. Maps and nested lists are kept as read-only values.
- **Writing values.**
  - Strings as JSON string literals.
  - Integers as they are. Floats always contain `.` or `e`; the specials are `.inf`, `-.inf`
    and `.nan`.
  - `true`, `false` and `null`.
  - Lists in flow style: `[a, b]`.
  - Never anchors, aliases or tags.
- **New records** are written in this order:
  ```
  id: "<uuid>"
  kind: "<kind>"
  kind-version: 1
  created: "<iso>"
  title: "<title>"
  <module fields, in creation order>
  <folder field last, if in a subfolder>
  ```
- **Editing a key.**
  - Replace only that value's bytes. Everything else (comments, order, quoting) stays.
  - A block list stays a block list (`- item` lines at the same indent).
  - `key:` with an empty value becomes `key: <value>`.
  - New keys are appended at the end. Removing a key deletes its line(s).
  - Key names are made of alphanumerics, `.`, `-` and `_`.
- **Refused edits.** A key whose value is a block scalar, a nested map, a multi-line plain
  scalar, an anchor, an alias or a tag. The record becomes read-only.
- **Body saves** replace only the body. The frontmatter bytes are kept, and a file without
  frontmatter stays without.

## Kinds

### Note

Fields:
- `notes.folder`
- `daily.date: "YYYY-MM-DD"`: a local date fixed at creation
- `archive.at`

A **daily note** is created at the top of `notes/`, titled with its date, with an empty body.
Example:

```
---
id: "0192f3a4-7c1e-7b2a-9f00-3e5d8c1a2b44"
kind: "note"
kind-version: 1
created: "2026-10-02T09:14:00Z"
title: "2026-10-02"
daily.date: "2026-10-02"
---
```

### Board

- **The `.md` file.**
  - Frontmatter: `kind: "board"` and `boards.scene-sha256` (the SHA-256 of the `.excalidraw`
    bytes the page was written from), plus `notes.folder` and `archive.at`.
  - The body is generated and never read back. Its first line is:
    ```
    <!-- Librarium writes this page from the board's drawing (<id>.excalidraw); edits here are replaced when the board is saved. -->
    ```
  - The body has one paragraph per element, joined by `\n\n`, ending in `\n`. Elements are in
    reading order: rows by `round(y/24)`, then by `x`.
    - A text element: its words, with each of its links written `[[label|id]]` where the label
      appears, or appended after it.
    - A text linked as a whole, or the bound text of a linked shape: `[[words|id]]`.
    - A linked shape, card or picture without words: `[[Name|id]]`, or `![[Name|id]]` when it is
      an embed.
- **The `.excalidraw` file** is Excalidraw's `serializeAsJSON(elements, appState, files,
  "local")`.
  - A new board is exactly:
    ```
    {\n  "type": "excalidraw",\n  "version": 2,\n  "source": "librarium",\n  "elements": [],\n  "appState": {},\n  "files": {}\n}\n
    ```
  - **A link to a record.** The element's `link` is `librarium://record/<id>`. Its `customData`
    is `{"librarium": {"links": [{"id", "label"}], "embed": true?}}`.
  - **Cards** are `embeddable` elements with that link and a transparent stroke and fill.
  - **Pictures** are `image` elements whose `fileId` is a library item's ID. Files keyed by a
    UUID are not stored in `files`.
- **Save order.** `.excalidraw`, then the page, then `boards.scene-sha256`. A missing drawing is
  the empty scene. The page is stale when the stored SHA differs.

### Capture

Fields, in order after the envelope:
- `captures.source`: the source record's UUID
- `captures.quote`: non-empty part quotes, each trimmed, joined with `" […] "`; empty for picture
  captures
- `captures.parts`: an integer
- `captures.locator`: the first part's place (`"p. 3"`, a chapter title); removed when no part
  has one

The title, and the body:
- **Title.** The first 8 words of the quote, plus `…` if there were more. With no quote, the
  title is `A region of <source title>`. When the quote changes, the title follows only if it
  was still the automatic one.
- **Body.** The user's words, right-trimmed, plus `\n`, or empty.

Sidecars are written first; the `.md` is the commit point. Example:

```
---
id: "0192f3b0-0000-7000-8000-000000000001"
kind: "capture"
kind-version: 1
created: "2026-10-02T09:20:11Z"
title: "The technique of our time is the…"
captures.source: "0192e7c2-0000-7000-8000-0000000000aa"
captures.quote: "The technique of our time is the …"
captures.parts: 1
captures.locator: "p. 3"
---
My own words.
```

### Item (`record.json`)

**Every item.** The envelope, plus:
- `library.format`: `pdf` | `epub` | `image` | `web`
- `library.folder`, when in a subfolder
- `archive.at`, when archived
- `provenance`

**Imported files** (pdf, epub, image) also have:
- `sha256` of the original
- `library.original: "original.<ext>"`, where `ext` comes from the magic bytes: `pdf`, `epub`,
  `png`, `jpg`, `gif`, `webp`, `heic` or `tiff`
- `provenance: {"original-name", "saved-at", "saved-with": "Librarium <ver> (import)",
  "source": null}`
- After extraction: `library.text: "extracted/text-v1.json"` and `library.pages` (pages or
  chapters)

**Saved web pages** have no `sha256` and no `library.original`. Instead they have:
- `library.snapshot`: the current snapshot's folder name
- `library.snapshots`: oldest first; each is `{"at", "checks": [{"kind", "reason"}],
  "final-url", "sha256" (of page.pdf), "status": int|null}`
  - A check's `kind` is one of `error`, `not-found`, `paywall`, `verification`, `sign-in`,
    `drawn`, `incomplete` or `empty`.
- `provenance: {"author", "final-url", "publication", "published", "saved-at",
  "saved-with": "Librarium <ver> (WebKit)", "source": "<url>"}`, with `null` for unknowns

Saving the same address again adds a snapshot to the item. Addresses match on `source` or
`final-url`, ignoring `#fragment` and a trailing `/`.

Example:

```json
{
  "created": "2026-10-02T09:14:00Z",
  "id": "0192e7c2-0000-7000-8000-0000000000aa",
  "kind": "item",
  "kind-version": 1,
  "library.format": "pdf",
  "library.original": "original.pdf",
  "library.pages": 12,
  "library.text": "extracted/text-v1.json",
  "provenance": {
    "original-name": "essay.pdf",
    "saved-at": "2026-10-02T09:14:00Z",
    "saved-with": "Librarium 0.1.0 (import)",
    "source": null
  },
  "sha256": "…",
  "title": "essay"
}
```

## Stored text

Stored text is never regenerated if it is present. Anchors point into it.

- **`extracted/text-v1.json`:**
  - **pdf:** `{"extractor": "pdfkit", "version": 1, "pages": [{"page": 1, "text"}]}`.
    - The fallback extractor is `"pdf-extract 0.12"`.
    - Pages with fewer than 16 non-space characters are recognised. They gain `"lines"` and
      `"recognized": true`, and the extractor becomes `"pdfkit + apple-vision 1"`.
  - **epub:** `{"extractor": "librarium-epub 1", "version": 1, "title", "creator", "publisher",
    "date", "language", "chapters": [{"href", "path", "title", "text"}]}`.
  - **image:** `{"extractor": "apple-vision 1", "version": 1, "pages": [{"page": 1, "text",
    "lines": [{"text", "confidence", "x", "y", "w", "h"}]}], "image": {"width", "height"}}`.
    Line boxes are 0–1 fractions measured from the top left.
- **`snapshots/<at>/text.json`:** `{"checks", "extractor": "webkit-page 1", "final_url",
  "images", "language", "status", "text", "title", "version": 1}`. The key is spelled
  `final_url`.
- **The text anchors see.**
  - pdf, epub and image: the page or chapter texts joined with `"\n\n"`. Each segment is
    labelled `p. N`, or with the chapter title (else `chapter N`).
  - web: the snapshot's `text`, unlabelled.
  - **All offsets are Unicode code points.**

## Anchors (`captures/<id>.anchor.json`)

```json
{
  "id": "<capture id>",
  "parts": [ <part>, ... ],
  "snapshot": "<at>" | null,
  "source": "<source id>",
  "text": {"extractor", "file": "extracted/text-v1.json" | "snapshots/<at>/text.json", "version", "snapshot"?} | null
}
```

- **Pairing.** A sidecar is paired with its capture by the `id` inside it. Lookup tries
  `<id>.anchor.json`, then scans. A sidecar without a capture is an orphan: it is listed, never
  deleted.
- **A part** is `{"selector": [...], "boxes"?: [{"page"?, "x", "y", "w", "h"}] (percent),
  "region"?: ".region-<N>.png"}`.
- **Selectors** form a flat list. The W3C types are:
  - `{"type": "TextQuoteSelector", "exact", "prefix", "suffix"}`, with up to 32 code points of
    context. If the passage wasn't found in the stored text, the context is empty and there is no
    position.
  - `{"type": "TextPositionSelector", "start", "end"}`, in code points into the stored text.
  - `{"type": "FragmentSelector", "value": "page=N", "conformsTo": "http://tools.ietf.org/rfc/rfc8118"}`
  - `{"type": "FragmentSelector", "value": "epubcfi(…)", "conformsTo": "http://www.idpf.org/epub/linking/cfi/epub-cfi.html"}`
  - `{"type": "FragmentSelector", "value": "xywh=percent:x,y,w,h", "conformsTo": "http://www.w3.org/TR/media-frags/"}`
- **Part shapes.**

  | Part | Selector | Extra fields |
  |---|---|---|
  | Text | `[quote, position]`, then `page=N` (PDF) or a CFI (EPUB) | `boxes` (PDF, image) |
  | PDF region | `[{page=N, "refinedBy": xywh}]` | `boxes`, `region` |
  | Image region | `[xywh]` | `boxes`, `region` |
  | EPUB picture | `[cfi]` or `[]` | `region` |

- **Editing parts.** Rewriting the parts renames region PNGs to their new index. Higher-numbered
  old PNGs are left in place.
- **Finding a place again.**
  1. Try the position, and check the quote is there.
  2. Otherwise search for the exact quote, using its context.
  3. Otherwise fuzzy-match (as Hypothesis does, `approx-string-match`). A match above the
     threshold is shown as *moved* until confirmed. Below it, the anchor is *lost*: listed, never
     drawn in the wrong place.

  Confirming a moved part rewrites `parts`.

## Links and embeds (in Markdown bodies)

- **Syntax.** A link is `[[label|<uuid>]]`; an embed is `![[label|<uuid>]]`. An image or board
  embed may be followed by `{width=N}`, in pixels (`^\{width=(\d{1,5})\}`, shown at least 48 px
  wide).
- **Parsing.**
  1. Find `[[`, skipping escaped positions.
  2. The link ends at the first `]]` on the same line. A newline, `[` or lone `]` before it
     means it isn't a link. `[[]]` isn't a link.
  3. The ID follows the **last unescaped** `|` and must be canonical. With no unescaped `|`, a
     final `\|<uuid>` also works (table cells).
  4. Otherwise the whole inside is the label, with no ID (*unresolved*). A damaged ID stays part
     of the label.
  5. Labels unescape `\\`, `\[`, `\]` and `\|`.
  6. `!` directly before `[[` (and not itself escaped) makes an embed.
- **Not links:** anything in inline code, a fenced code block, an HTML block or inline HTML.
  **Indented lines are not code.** Strip each line's leading whitespace before Markdown parsing.
- **Writing a label.** Escape `\ [ ] |` with `\`, and replace each run of newlines with one space.
- **Labels are caches.**
  - When a target is renamed, a link's label follows only if it equals the old title and the link
    isn't an embed.
  - A missing ID is filled in only when exactly one record has that title.
- **Default labels.** A capture embed's label is the first words of the quote. Any other embed's
  label is the target's title.
- Images in notes are library items (in `items/Attachments/`), embedded on their own line.
- Web links are ordinary Markdown links.

## Archive and deletion

- **Archived** means `archive.at: "<iso>"` is present and non-null. Archiving touches only that
  key; restoring removes it. There is no trash folder.
- **Deleting a folder** archives everything in it, then removes the empty folders.
- **Permanent deletion** applies to archived records only. It removes the record's file, then its
  sidecars (or the whole item folder), and forgets its history.

## Arrangement (`.librarium/order.json`)

```
{ "<notes|items>": { "<folder path, or \"\" at the top>": ["<uuid>" | "folder:<name>", ...] } }
```

Keys are sorted and empty maps dropped. Entries follow folder moves, and unlisted entries come
after the listed ones.

## Version history (`.librarium/history/`)

History covers Markdown records only.

- `objects/<first 2 hex>/<sha256>`: a version's exact bytes, written once.
- `log/<device>.jsonl`: one compact JSON line per entry, each ending in `\n`.
  - A version line: `{"id", "kind", "path", "title", "hash", "ms", "origin", "size", "device"}`,
    in that order. `origin` is `app`, `outside`, `before-restore` or `restore`.
  - A forget line: `{"forget": "<uuid>", "ms"}`.
  - Each Mac writes only its own log and reads all of them.
- `README.txt` is written if missing.
- **Retention.** Keep everything for 24 h, then hourly for 7 days, daily for 90 days, weekly
  after that. The newest version is always kept.

## Repairs (at startup and after outside changes)

Repairs run only after 3 s with no outside changes, and never while a git operation is in
progress (`.git/index.lock`, `MERGE_HEAD`, `rebase-merge`, `rebase-apply`, `CHERRY_PICK_HEAD` or
`REVERT_HEAD`).

- **Two files with one ID.** The original is the one at the known path, else the one with the
  canonical name, else the one created earlier. The other is classified:
  1. A conflict-style name (`sync-conflict`, `conflicted copy`, `(conflict`, `conflict)`,
     `conflicted`, or a stem ending in ` <digits>`) → **conflict**.
  2. A Finder copy name (stem ends in ` copy` or ` copy N`) → **copy**.
  3. At least 80% line similarity → **conflict**.
  4. Otherwise → **copy**.

  A conflict is shown as two versions to compare, never merged silently. A copy gets a new ID
  and `copied-from`, and is renamed canonically.
- **No ID, or a damaged ID.**
  - The file is renamed to `<id>-<slug>.md` and the ID written in. A damaged ID that still parses
    is reused in canonical form.
  - Missing `kind` and `title` are added. A file without frontmatter gets a full envelope.
  - Unparsable frontmatter is never touched.

## App data (`~/Library/Application Support/local.librarium.desktop/`)

App data is per device and never synced.

**`settings.json`.** Settings carry over from the current app, so these keys must stay:
- `store.path`
- `window.main`: `{x, y, width, height, maximized}`
- `ui.theme`: `system` | `light` | `dark`
- `ui.textSize`: 14 | 16 | 18
- `ui.sidebar`, `ui.sidePanel`, `ui.panelView`, `ui.icloudNoted`
- `ui.recent`, `ui.folded`, `ui.unfolded`
- `ui.tabs`: `{"tabs": [{"stack": [{"page", "params"}], "index", "title"}], "active"}`
- `folders.sort.<kind>`: `{key, dir}`
- `folders.view.<kind>`: `list` | `icons`
- `captures.group`, `captures.show`
- `daily.dayStart`: 0–12, default 4
- `reader.epub`: `{fontSize, font, matchApp, theme, layout, spacing, width, justify}`
- `reader.place.<item id>`: a Readium locator

**`libraries/<library id>/`:**
- `device.json`: `{"device": "<uuid>"}`. This is the history log's name, so keep it.
- `drafts/<id>.json`: `{"id", "base_version", "base_body", "body", "updated_ms"}`. Unsaved text,
  read at startup.
- Anything else here (indexes, job queue, change-replay state) may be replaced.

Logs are written to `~/Library/Logs/local.librarium.desktop/`.
