# 0072. Releases on GitHub, updates that ask first

- Status: accepted (amends the brief's packaging line: the app is now distributed)
- Date: 2026-10-08
- Request: R-069 in `docs/REQUESTS.md`

## Context and problem

The user wants others to install Librarium, and it to update automatically or very easily.
The brief had "an ad-hoc signed `.app` for personal use; notarisation only if it is ever
distributed." The user chose:

- not to join Apple's Developer Program for now;
- one public GitHub repository for the code and the releases;
- updates that ask first.

## Decision

- **Tauri's updater** (`tauri-plugin-updater`). Updates are signed with our own key
  (`.secrets/updater.key`, ignored by git; its public half is in `tauri.conf.json`). The app
  accepts only an update signed with it, whoever hosts the files.
- **Published as GitHub releases** of `PartlyWhole/Librarium` by `npm run release -- X "notes"`
  (`scripts/release.mjs`, `docs/RELEASING.md`). Installed copies read
  `releases/latest/download/latest.json`.
- **Asked first** (`src/features/updates/`):
  - the app looks 20 seconds after it starts, then daily;
  - a newer version shows as a quiet note, *Librarium X is available*, with **Update…**,
    which shows what's new with **Install** and **Later**;
  - installed, it asks **Restart now** or **Later** (the new version starts at the next
    launch either way);
  - Later isn't asked again by itself until the app restarts;
  - **Librarium ▸ Check for Updates…** and Settings ▸ Version look at any time, and say when
    there's nothing new or the page can't be reached.
- **Restarting saves first,** as closing does: the interface's close handlers (notes,
  drafts, preferences), then the app's own `restart` command, which remembers the window and
  closes the library before restarting.
- **First installs come as a `.dmg`,** also published as `Librarium.dmg`, so one link always
  gives the newest. `docs/INSTALL.md` explains the one-time *Open Anyway* step that an app
  without Apple's Developer ID needs.
- Development copies never look for updates.
- The app ID (`local.librarium.desktop`) stays, so nobody's settings move.

## Consequences

- Without a Developer ID:
  - Gatekeeper refuses the first open until *Open Anyway*. Updates aren't affected: the app
    downloads them itself, so they carry no quarantine.
  - Each version's ad-hoc signature differs, so macOS may ask again for access to Documents,
    Desktop or Downloads after an update. Joining the program later fixes both, with nothing
    else changed (`docs/RELEASING.md`).
- Releases are built on the maintainer's Apple-silicon Mac: Apple silicon only, macOS 15+.
  A universal build (Intel too) would need the worker built for both.
- Losing the update key means installed copies can't be updated (a fresh download would
  be needed).
- Checked:
  - the update's signature verifies against the app's key;
  - an installed test copy (its own app ID) found a locally served update by itself;
  - the user clicked through install and restart (see R-069).

  Interface tests cover the flow with the backend's mock.
