# 0002. saphyr-parser plus our own byte-span editing for frontmatter

- Status: accepted
- Date: 2026-10-02

## Context and problem

BRIEF §5.3: frontmatter is read as any YAML 1.2 and written byte-precisely. Only the bytes of
the keys the app writes may change; unknown keys, values, comments and order are kept exactly.
`serde_yaml` is ruled out (deprecated). The brief offers `yaml-edit`, or `saphyr-parser` plus
our own byte-span editing.

## Options considered

- **yaml-edit** (0.3): a lossless, rowan-based CST editor. Young (about 130k downloads), and its
  API is still moving.
- **saphyr-parser** (0.1): a YAML 1.2 event parser that passes the yaml-test-suite and reports
  the byte position of every event. It is widely used (millions of downloads).

## Decision

`saphyr-parser`, with our own byte-span editor in the kernel's frontmatter codec.

- The app only ever writes flat top-level keys with scalar or flat-list values (§5.3), so
  an edit is a small splice: replace one value's byte span, or append a `key: value` line.
  That is easy to own and to test byte for byte.
- Reading uses the full YAML 1.2 parser, so any frontmatter the user writes is understood.
- If a key the app must write has a complex form (a block scalar, a nested map, an anchor),
  the codec refuses and the record opens read-only, never rewritten.

## Consequences

- Round-trip tests check byte equality for every fixture.
- We maintain about a few hundred lines of span editing instead of tracking another crate's
  evolving CST API.
