# 0010. "Folder" for the user's library folder in API names

- Status: accepted
- Date: 2026-10-02

## Context and problem

The brief uses "library" for both the user's whole folder (§5.1, `library.json`) and the
Library feature (saved pages, PDFs, EPUBs), whose fields use the prefix `library.`. The
direction test forbids the kernel and the API from naming a feature, even in a string.

## Decision

- API calls about the user's folder are `folder.status`, `folder.open` and `folder.close`.
  The settings key for its path is `store.path`.
- The feature-name guard checks string literals (a feature's ID, or its `id.` field prefix)
  and references to feature crates. It does not check bare Rust identifiers, which name kernel
  concepts (the kernel's `Library` type is the user's folder). The brief's own file name
  `library.json` is allowed.

## Consequences

`library.*` strings stay free for the Library feature's fields and API calls.
