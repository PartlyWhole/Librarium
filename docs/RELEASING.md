# Releasing a new version (for the maintainer)

Decision 0072. Each release is a GitHub release of `PartlyWhole/Librarium`; installed copies read
`latest.json` from the newest release and offer the update.

## Once

- The update key is `.secrets/updater.key` (ignored by git). **Keep a copy somewhere safe** (a
  password manager). Updates are signed with it and installed copies accept only updates
  signed with it: without it, everyone would have to download the app again.
- `gh auth status` must show you signed in to GitHub.

## Each release

```bash
npm run release -- 0.2.0 "Footnotes open in a popover. Resize pictures in notes."
```

It checks you're on `main` with nothing uncommitted, sets the version everywhere, runs the
tests (add `--skip-tests` to skip them), builds and signs the app, commits *Release 0.2.0*,
tags `v0.2.0`, pushes, and publishes the release with:

- `Librarium_0.2.0_aarch64.dmg` and `Librarium.dmg` (the same; the second keeps the
  download link in `docs/INSTALL.md` working for every version);
- `Librarium.app.tar.gz` and its `.sig`: the update itself;
- `latest.json`: the version, the notes, and where the update is.

Installed copies offer it within a day. Versions only go up: 0.2.0 → 0.2.1 → 0.3.0.

## Later: Apple's Developer Program

With a Developer ID certificate the first install opens without the *Open Anyway* step, and
updates never re-ask for folder access. Set `signingIdentity` in `src-tauri/tauri.conf.json` to
the certificate's name and give the build `APPLE_API_KEY`, `APPLE_API_ISSUER` and
`APPLE_API_KEY_PATH` (an App Store Connect key) to notarise. Installed copies keep updating as
before: the update key, not Apple's, decides what they accept.
