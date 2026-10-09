/**
 * Reading settings for books, after Apple Books (per device, `reader.epub` in settings.json):
 * what they are, how they become Readium preferences, and the Aa panel that changes them.
 */
import type { IEpubPreferences } from "@readium/navigator";
import { h } from "../../ui/dom";
import type { Layout } from "../types";


export type Theme = "white" | "sepia" | "gray" | "night";
export type Font = keyof typeof FONTS;
/** How pages are laid out, as in Apple Books' View menu. "two" shows one when there isn't room. */
export const LAYOUTS: [Layout, string][] = [["single", "Single page"], ["two", "Two pages"], ["scroll", "Scroll"]];

export interface ReadingSettings {
  /** 1 = the book's size. */
  fontSize: number;
  font: Font;
  /** Follow the app's light or dark appearance (white or night). */
  matchApp: boolean;
  theme: Theme;
  layout: Layout;
  spacing: "book" | "tight" | "normal" | "loose";
  width: "narrow" | "medium" | "wide";
  justify: boolean;
}

export const DEFAULT_SETTINGS: ReadingSettings = { fontSize: 1, font: "original", matchApp: true, theme: "white", layout: "two", spacing: "book", width: "medium", justify: false };

/** The fonts offered, as Apple Books offers them (all ship with macOS). */
export const FONTS = {
  original: { name: "Original", stack: null },
  athelas: { name: "Athelas", stack: "Athelas, Georgia, serif" },
  charter: { name: "Charter", stack: "Charter, Georgia, serif" },
  georgia: { name: "Georgia", stack: "Georgia, serif" },
  iowan: { name: "Iowan", stack: '"Iowan Old Style", Georgia, serif' },
  palatino: { name: "Palatino", stack: "Palatino, \"Palatino Linotype\", serif" },
  sf: { name: "San Francisco", stack: "-apple-system, BlinkMacSystemFont, \"Helvetica Neue\", sans-serif" },
  seravek: { name: "Seravek", stack: "Seravek, \"Gill Sans\", sans-serif" },
  times: { name: "Times New Roman", stack: "\"Times New Roman\", Times, serif" },
} as const;

export const THEMES: Record<Theme, { name: string; backgroundColor: string; textColor: string; linkColor: string }> = {
  white: { name: "White", backgroundColor: "#ffffff", textColor: "#121212", linkColor: "#2a5db0" },
  sepia: { name: "Sepia", backgroundColor: "#f8f1e3", textColor: "#4f321c", linkColor: "#8a4f16" },
  gray: { name: "Gray", backgroundColor: "#4a4a4d", textColor: "#e3e3e3", linkColor: "#a8c7fa" },
  night: { name: "Night", backgroundColor: "#1c1c1e", textColor: "#cfcfcf", linkColor: "#8ab4f8" },
};

const SPACING = { tight: 1.35, normal: 1.55, loose: 1.8 };
/** The page's side margins on screen, in pixels, at any text size. */
const GUTTER = 56;
const WIDTH = { narrow: [45, 55, 65], medium: [50, 66, 80], wide: [60, 85, 100] } as const;

/** The saved settings, each value checked; settings from the first version are carried over. */
export function readSettings(saved: unknown): ReadingSettings {
  const raw = (saved ?? {}) as Record<string, unknown>;
  const pick = <K extends keyof ReadingSettings>(k: K, allowed: readonly unknown[], v: unknown = raw[k]): ReadingSettings[K] =>
    allowed.includes(v) ? (v as ReadingSettings[K]) : DEFAULT_SETTINGS[k];
  const oldFont = ({ book: "original", serif: "iowan", sans: "sf" } as Record<string, string>)[String(raw.font)];
  const oldTheme = ({ light: "white", dark: "night", sepia: "sepia" } as Record<string, string>)[String(raw.theme)];
  const size = typeof raw.fontSize === "number" && raw.fontSize >= 0.6 && raw.fontSize <= 2.5 ? raw.fontSize : 1;
  return {
    fontSize: size,
    font: pick("font", Object.keys(FONTS), oldFont ?? raw.font),
    matchApp: typeof raw.matchApp === "boolean" ? raw.matchApp : raw.theme === "auto" || raw.theme === undefined,
    theme: pick("theme", Object.keys(THEMES), oldTheme ?? raw.theme),
    // Older settings: a scrolling switch, and "Pages: two when wide / one".
    layout: pick("layout", ["single", "two", "scroll"], raw.scroll === true || raw.layout === "scroll" ? "scroll" : raw.scroll === false || raw.columns ? (raw.columns === "one" ? "single" : "two") : raw.layout),
    spacing: pick("spacing", ["book", "tight", "normal", "loose"]),
    width: pick("width", ["narrow", "medium", "wide"]),
    justify: raw.justify === true,
  };
}

/** Whether the app looks dark now. */
function appIsDark(): boolean {
  const t = document.documentElement.dataset.theme;
  return t === "dark" || (t !== "light" && !!window.matchMedia?.("(prefers-color-scheme: dark)").matches);
}

/** The theme in effect (matching the app picks white or night). */
export function themeOf(s: ReadingSettings): Theme {
  return s.matchApp ? (appIsDark() ? "night" : "white") : s.theme;
}

/** Settings as Readium preferences. */
export function toPreferences(s: ReadingSettings): IEpubPreferences {
  // Readium sizes text with CSS zoom on the page, which scales the margins too, and measures
  // line length in characters, so larger text took the margins and could jump to one wide
  // column. As in Books, the page keeps its margins and column and fewer words fit: the margin
  // is divided by the size, and above 100% so are the line lengths (below it, Readium already
  // compensates).
  const grow = Math.max(1, s.fontSize);
  const [minimal, optimal, maximal] = WIDTH[s.width].map((n) => Math.max(12, Math.round(n / grow))) as [number, number, number];
  const { backgroundColor, textColor, linkColor } = THEMES[themeOf(s)];
  return {
    fontSize: s.fontSize,
    fontFamily: FONTS[s.font].stack,
    lineHeight: s.spacing === "book" ? null : SPACING[s.spacing],
    minimalLineLength: minimal,
    optimalLineLength: optimal,
    maximalLineLength: maximal,
    scroll: s.layout === "scroll",
    // Two pages when the lines fit (Readium decides from the line length), else one.
    columnCount: s.layout === "single" ? 1 : null,
    textAlign: s.justify ? ("justify" as IEpubPreferences["textAlign"]) : null,
    // Roomy margins, as in Books.
    pageGutter: Math.round(GUTTER / s.fontSize),
    // Scrolling has the same side margins as pages (Readium leaves none by default).
    scrollPaddingLeft: Math.round(GUTTER / s.fontSize),
    scrollPaddingRight: Math.round(GUTTER / s.fontSize),
    scrollPaddingTop: Math.round(24 / s.fontSize),
    scrollPaddingBottom: Math.round(48 / s.fontSize),
    backgroundColor,
    textColor,
    linkColor,
  };
}

/**
 * The Aa panel, after Apple Books: text size and the layout first (single page, two pages,
 * scroll), then theme and font, and finer settings under Customise.
 * `pagesShown` says how many pages are on screen now, so "Two pages" can say when there isn't
 * room; the reader sends `laidout` (with the settings now) when that may have changed.
 */
export function settingsPanel(s: ReadingSettings, apply: (s: ReadingSettings) => void, close: () => void, fixed: boolean, pagesShown: () => number | null = () => null): HTMLElement {
  let cur = s;
  let customising = false;
  const set = (patch: Partial<ReadingSettings>) => {
    cur = { ...cur, ...patch };
    apply(cur);
    refresh();
  };
  const step = (d: number) => set({ fontSize: Math.min(2.5, Math.max(0.6, Math.round((cur.fontSize + d) * 100) / 100)) });
  const sizes = h("div", { class: "aa-sizes" },
    h("button", { type: "button", class: "aa-size small-a", "aria-label": "Smaller text", onclick: () => step(-0.1) }, "A"),
    h("button", { type: "button", class: "aa-size large-a", "aria-label": "Larger text", onclick: () => step(0.1) }, "A"));
  const layout = h("div", { class: "seg aa-layout", role: "radiogroup", "aria-label": "Layout" },
    LAYOUTS.map(([value, text]) => h("button", { type: "button", role: "radio", "data-value": value, onclick: () => set({ layout: value }) }, text)));
  const roomNote = h("p", { class: "aa-note muted small", "aria-live": "polite", hidden: true }, "Not enough room for two pages, so one is shown. A wider window or smaller text makes room.");
  const swatches = h("div", { class: "aa-themes", role: "radiogroup", "aria-label": "Theme" },
    (Object.keys(THEMES) as Theme[]).map((t) => h("button", { type: "button", role: "radio", class: `aa-swatch theme-${t}`, "data-value": t, "aria-label": THEMES[t].name, title: THEMES[t].name, onclick: () => set({ theme: t, matchApp: false }) }, h("span", null, "Aa"))));
  const match = h("input", { type: "checkbox", onchange: () => set({ matchApp: match.checked }) }) as HTMLInputElement;
  // One row: each font named in its own face.
  const font = h("select", { class: "aa-font-pick", "aria-label": "Font", onchange: () => set({ font: font.value as Font }) },
    (Object.keys(FONTS) as Font[]).map((f) => h("option", { value: f, style: FONTS[f].stack ? `font-family: ${FONTS[f].stack}` : "" }, FONTS[f].name))) as HTMLSelectElement;
  const justify = h("input", { type: "checkbox", onchange: () => set({ justify: justify.checked }) }) as HTMLInputElement;
  const seg = <K extends "spacing" | "width">(label: string, key: K, options: [ReadingSettings[K], string][]) => {
    const group = h("div", { class: "seg", role: "radiogroup", "aria-label": label },
      options.map(([value, text]) => h("button", { type: "button", role: "radio", "data-value": String(value), onclick: () => set({ [key]: value } as Partial<ReadingSettings>) }, text)));
    return { key, group, row: h("div", { class: "epub-setting" }, h("span", { class: "epub-setting-label" }, label), group) };
  };
  const segs = [
    seg("Line spacing", "spacing", [["book", "Book’s"], ["tight", "Tight"], ["normal", "Normal"], ["loose", "Loose"]]),
    seg("Line length", "width", [["narrow", "Narrow"], ["medium", "Medium"], ["wide", "Wide"]]),
  ];
  const custom = h("div", { class: "aa-custom", hidden: true }, segs.map((x) => x.row), h("label", { class: "aa-toggle" }, h("span", null, "Justify text"), justify));
  const customBtn = h("button", { type: "button", class: "aa-disclose", "aria-expanded": "false", onclick: () => ((customising = !customising), refresh()) }, "Customise");
  const refresh = () => {
    const theme = themeOf(cur);
    for (const b of swatches.querySelectorAll<HTMLButtonElement>("button")) b.setAttribute("aria-checked", String(b.dataset.value === theme));
    for (const b of layout.querySelectorAll<HTMLButtonElement>("button")) b.setAttribute("aria-checked", String(b.dataset.value === cur.layout));
    for (const x of segs) for (const b of x.group.querySelectorAll<HTMLButtonElement>("button")) b.setAttribute("aria-checked", String(b.dataset.value === String(cur[x.key])));
    roomNote.hidden = cur.layout !== "two" || pagesShown() !== 1;
    font.value = cur.font;
    match.checked = cur.matchApp;
    justify.checked = cur.justify;
    custom.hidden = !customising;
    customBtn.setAttribute("aria-expanded", String(customising));
  };
  const panel = h("div", { class: "epub-popover epub-settings", role: "dialog", "aria-label": "Reading settings" },
    fixed ? h("p", { class: "muted small" }, "This book has fixed pages, so its text can’t be restyled.") : [sizes, layout, roomNote],
    swatches,
    h("label", { class: "aa-toggle" }, h("span", null, "Match the app’s appearance"), match),
    fixed ? null : [h("label", { class: "aa-toggle" }, h("span", null, "Font"), font), customBtn, custom],
    h("div", { class: "epub-settings-foot" }, h("button", { type: "button", class: "link-button small", onclick: () => set({ ...DEFAULT_SETTINGS }) }, "Reset"), h("button", { type: "button", class: "link-button small", onclick: close }, "Done")));
  // The settings now (changed from the View menu too) and the pages shown.
  panel.addEventListener("laidout", (e) => {
    const now = (e as CustomEvent<ReadingSettings | undefined>).detail;
    if (now) cur = now;
    refresh();
  });
  panel.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      close();
    }
  });
  refresh();
  return panel;
}
