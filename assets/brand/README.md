# Librarium's icon

- `librarium-icon-kit/`: the bold icon kit as supplied (2026-10-04; it replaced the refined kit: thicker strokes, the mark re-centred), without its Android and
  iOS folders. Five colourways (Parchment, Evergreen & gold, Midnight, Aubergine,
  Terracotta), masters (gold, black, white, currentColor), web and desktop exports, and its
  own README and `palette.json`.
- `app-icon-macos.svg`: the app icon (**Evergreen & gold**, the kit's recommendation) placed
  on macOS's icon grid: 824 px of artwork in a 1024 px canvas with a 100 px transparent margin.
  The kit's own desktop icon fills the whole canvas, so in the Dock it would look larger than
  other apps.

## Regenerating the app's icons

```bash
npx tauri icon assets/brand/app-icon-macos.svg -o /tmp/librarium-icons
```

Copy `32x32.png`, `128x128.png`, `128x128@2x.png`, `icon.icns` and `icon.png` into
`src-tauri/icons/` (the files `tauri.conf.json` lists). To use another colourway, make
`app-icon-macos.svg` from that colourway's `app-icon-rounded.svg` the same way.

The mark in the interface (`src/kit/logo.ts`) is the currentColor master, drawn in the
accent colour.
