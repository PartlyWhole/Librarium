# Librarium

A personal notebook and library for slow, careful intellectual work: read thinkers closely,
quote them exactly, and let your own ideas grow on top of what you read. One person, one Mac,
plain files in a folder you choose.

**To install it:** download
[Librarium.dmg](https://github.com/PartlyWhole/Librarium/releases/latest/download/Librarium.dmg)
and follow [docs/INSTALL.md](docs/INSTALL.md) (Apple silicon, macOS 15+). It updates itself.

## Working on it

- [SPEC.md](SPEC.md) says what the app does and how it looks.
- [FORMAT.md](FORMAT.md) describes the files it keeps your library in.
- [ARCHITECTURE.md](ARCHITECTURE.md) says where the code is.

Requirements: macOS 15+, Rust, Node 20.11+, Apple's command-line tools.

```bash
npm install
npm run dev        # the app
npm test           # the tests (Rust and TypeScript)
```

## Releasing

```bash
npm run release -- 0.2.0 "What's new, in a sentence or two."
```

The script must run on `main` with nothing uncommitted. It does the rest:
- sets the version
- runs the tests
- builds and signs the app with the update key `.secrets/updater.key`
- tags and pushes
- publishes a GitHub release that installed copies update to within a day

Keep a copy of the update key somewhere safe. Installed copies accept only updates signed with
it.
