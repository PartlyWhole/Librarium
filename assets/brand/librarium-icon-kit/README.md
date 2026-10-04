# Librarium icon kit

The supplied book-and-library design has been redrawn as real SVG paths. Refined edition: house walls terminate at the page edges, the roof has more clearance, and gently softened corners and more balanced proportions improve clarity. The geometry is symmetrical and flat, with clean edges and no embedded bitmap. The SVGs remain editable. The four-pane window and intersecting house/book outlines are retained.

## Colorways

- **Parchment**: forest green on warm paper. Recommended light appearance.
- **Evergreen & gold**: pale antique gold on deep green. Recommended app icon.
- **Midnight**: warm ivory on ink blue.
- **Aubergine**: pale lilac on dark plum.
- **Terracotta**: warm porcelain on fired clay.

Exact colors are in palette.json. masters/ includes transparent original-gold, black, white, and currentColor SVGs. currentColor inherits the surrounding color when inserted inline in HTML.

## Files in each colorway

- logo.svg and logo-transparent-1024.png: transparent standalone mark.
- app-icon.svg: opaque square icon. Let the operating system apply its own mask.
- app-icon-rounded.svg and preview-rounded.png: rounded presentation artwork and desktop source.
- png/: square PNG exports from 16 to 1024 pixels. The 16–32 pixel icons have slightly heavier strokes and a wider window gap for clarity.
- web/: favicon.svg, multi-resolution favicon.ico, apple-touch-icon.png, 192/512 icons, maskable icons, and a starter manifest.webmanifest. Adjust start_url for your deployment. Keep these files together or update the manifest paths.
- desktop/: Windows ICO and macOS ICNS, plus the editable PNG iconset.
- ios/AppIcon.appiconset/: iPhone, iPad and 1024-pixel marketing assets with Contents.json. PNGs are opaque RGB without alpha.
- android/: legacy launcher PNGs in five density folders and a Play Store PNG. Includes native adaptive icon XML for Android 8+, vector foregrounds, background colors, and a monochrome layer declaration for Android 13+ themed icons. Copy the contents of android/ into your app resource folder, excluding play-store-512.png; set the application icon to @mipmap/ic_launcher. Resource names may need adjustment if your app already defines them.
- maskable.svg: extra safe padding for custom launcher masks. Used by the web maskable exports.

## Web usage

```html
<link rel="icon" href="/icons/favicon.svg" type="image/svg+xml">
<link rel="icon" href="/icons/favicon.ico" sizes="any">
<link rel="apple-touch-icon" href="/icons/apple-touch-icon.png">
<link rel="manifest" href="/icons/manifest.webmanifest">
```

Preview colorways.png to compare the palettes and actual 16, 32 and 64 pixel exports. Small raster icons necessarily simplify the appearance of the curves. The SVG master is the source of truth for large-format use.
