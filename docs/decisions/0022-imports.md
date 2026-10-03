# 0022. How files are imported into the library

- Status: accepted
- Date: 2026-10-02

## Context and problem

§6: imports are staged in Application Support and moved in with one rename. The library folder
can be on another volume, where a rename from Application Support fails (EXDEV).

## Decision

- The original is copied untouched into `staging/<id>/original.<ext>` with its `record.json`
  (sha256 of the original, provenance: original name, saved-at, saved-with). Both are flushed.
- The writer moves the whole folder to `items/<id>-<slug>/` with one exclusive rename and
  indexes it.
- If the rename crosses volumes, the staged folder is first copied to
  `<library>/.librarium/staging/<id>/`, then moved in with one rename from there.
- Formats are recognised by their first bytes (PDF, EPUB, PNG, JPEG, GIF, WebP, HEIC, TIFF).
- Text is extracted afterwards by a resumable job in the worker and stored as
  `extracted/text-v1.json`, stamped with the extractor's name and version. The job then sets
  `library.text` in `record.json`, which is the commit point and changes the record's
  version, so views re-index it. An EPUB's own title replaces the file name unless the user
  has renamed the item.
- PDF text comes from `pdf-extract` (pure Rust); EPUB text from our own reader over `zip`
  and `roxmltree`. Both run in the worker. The worker keeps a private copy of stdout for
  replies (parsers sometimes print), and catches parser panics as errors.

## Consequences

The whole original is read into memory to hash and copy it; very large files (hundreds of MB)
are slow but work.
