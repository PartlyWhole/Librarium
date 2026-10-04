/**
 * Reading settings for books, after Apple Books (per device, through the reader store): what
 * they are, how they become Readium preferences, and the Aa panel that changes them.
 */
import type { IEpubPreferences } from "@readium/navigator";
import { h } from "../../kit/dom";
import type { ReaderStore } from "../host";

export type Theme = "white" | "sepia" | "gray" | "night";
export type Font = keyof typeof FONTS;

export interface ReadingSettings {
  /** 1 = the book's size. */
  fontSize: number;
  font: Font;
  /** Follow the app's light or dark appearance (white or night). */
  matchApp: boolean;
  theme: Theme;
  scroll: boolean;
  spacing: "book" | "tight" | "normal" | "loose";
  width: "narrow" | "medium" | "wide";
  columns: "auto" | "one";
  justify: boolean;
}

export const DEFAULT_SETTINGS: ReadingSettings = { fontSize: 1, font: "original", matchApp: true, theme: "white", scroll: false, spacing: "book", width: "medium", columns: "auto", justify: false };

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
const WIDTH = { narrow: [45, 55, 65], medium: [50, 66, 80], wide: [60, 85, 100] } as const;

/** The saved settings, each value checked; settings from the first version are carried over. */
export function readSettings(store: ReaderStore | undefined): ReadingSettings {
  const raw = (store?.get("reader.epub") ?? {}) as Record<string, unknown>;
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
    scroll: typeof raw.scroll === "boolean" ? raw.scroll : raw.layout === "scroll",
    spacing: pick("spacing", ["book", "tight", "normal", "loose"]),
    width: pick("width", ["narrow", "medium", "wide"]),
    columns: pick("columns", ["auto", "one"]),
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
  const [minimal, optimal, maximal] = WIDTH[s.width];
  const { backgroundColor, textColor, linkColor } = THEMES[themeOf(s)];
  return {
    fontSize: s.fontSize,
    fontFamily: FONTS[s.font].stack,
    lineHeight: s.spacing === "book" ? null : SPACING[s.spacing],
    minimalLineLength: minimal,
    optimalLineLength: optimal,
    maximalLineLength: maximal,
    scroll: s.scroll,
    columnCount: s.columns === "one" ? 1 : null,
    textAlign: s.justify ? ("justify" as IEpubPreferences["textAlign"]) : null,
    // Roomy margins, as in Books.
    pageGutter: 56,
    scrollPaddingTop: 24,
    scrollPaddingBottom: 48,
    backgroundColor,
    textColor,
    linkColor,
  };
}

/** The Aa panel: text size, theme, font, scrolling, and finer settings under Customise. */
export function settingsPanel(s: ReadingSettings, apply: (s: ReadingSettings) => void, close: () => void, fixed: boolean): HTMLElement {
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
  const swatches = h("div", { class: "aa-themes", role: "radiogroup", "aria-label": "Theme" },
    (Object.keys(THEMES) as Theme[]).map((t) => h("button", { type: "button", role: "radio", class: `aa-swatch theme-${t}`, "data-value": t, "aria-label": THEMES[t].name, title: THEMES[t].name, onclick: () => set({ theme: t, matchApp: false }) }, h("span", null, "Aa"))));
  const match = h("input", { type: "checkbox", onchange: () => set({ matchApp: match.checked }) }) as HTMLInputElement;
  const fonts = h("div", { class: "aa-fonts", role: "radiogroup", "aria-label": "Font" },
    (Object.keys(FONTS) as Font[]).map((f) => h("button", { type: "button", role: "radio", class: "aa-font", "data-value": f, style: FONTS[f].stack ? `font-family: ${FONTS[f].stack}` : "", onclick: () => set({ font: f }) }, h("span", null, FONTS[f].name), h("span", { class: "aa-check", "aria-hidden": "true" }, "✓"))));
  const scroll = h("input", { type: "checkbox", onchange: () => set({ scroll: scroll.checked }) }) as HTMLInputElement;
  const justify = h("input", { type: "checkbox", onchange: () => set({ justify: justify.checked }) }) as HTMLInputElement;
  const seg = <K extends "spacing" | "width" | "columns">(label: string, key: K, options: [ReadingSettings[K], string][]) => {
    const group = h("div", { class: "seg", role: "radiogroup", "aria-label": label },
      options.map(([value, text]) => h("button", { type: "button", role: "radio", "data-value": String(value), onclick: () => set({ [key]: value } as Partial<ReadingSettings>) }, text)));
    return { key, group, row: h("div", { class: "epub-setting" }, h("span", { class: "epub-setting-label" }, label), group) };
  };
  const segs = [
    seg("Line spacing", "spacing", [["book", "Book’s"], ["tight", "Tight"], ["normal", "Normal"], ["loose", "Loose"]]),
    seg("Line length", "width", [["narrow", "Narrow"], ["medium", "Medium"], ["wide", "Wide"]]),
    seg("Pages", "columns", [["auto", "Two when wide"], ["one", "One"]]),
  ];
  const custom = h("div", { class: "aa-custom", hidden: true }, segs.map((x) => x.row), h("label", { class: "aa-toggle" }, h("span", null, "Justify text"), justify));
  const customBtn = h("button", { type: "button", class: "aa-disclose", "aria-expanded": "false", onclick: () => ((customising = !customising), refresh()) }, "Customise");
  const refresh = () => {
    const theme = themeOf(cur);
    for (const b of swatches.querySelectorAll<HTMLButtonElement>("button")) b.setAttribute("aria-checked", String(b.dataset.value === theme));
    for (const b of fonts.querySelectorAll<HTMLButtonElement>("button")) b.setAttribute("aria-checked", String(b.dataset.value === cur.font));
    for (const x of segs) for (const b of x.group.querySelectorAll<HTMLButtonElement>("button")) b.setAttribute("aria-checked", String(b.dataset.value === String(cur[x.key])));
    segs.find((x) => x.key === "columns")!.row.hidden = cur.scroll;
    match.checked = cur.matchApp;
    scroll.checked = cur.scroll;
    justify.checked = cur.justify;
    custom.hidden = !customising;
    customBtn.setAttribute("aria-expanded", String(customising));
  };
  const panel = h("div", { class: "epub-popover epub-settings", role: "dialog", "aria-label": "Reading settings" },
    fixed ? h("p", { class: "muted small" }, "This book has fixed pages, so its text can’t be restyled.") : sizes,
    swatches,
    h("label", { class: "aa-toggle" }, h("span", null, "Match the app’s appearance"), match),
    fixed ? null : [fonts, h("label", { class: "aa-toggle" }, h("span", null, "Scrolling view"), scroll), customBtn, custom],
    h("div", { class: "epub-settings-foot" }, h("button", { type: "button", class: "link-button small", onclick: () => set({ ...DEFAULT_SETTINGS }) }, "Reset"), h("button", { type: "button", class: "link-button small", onclick: close }, "Done")));
  panel.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      close();
    }
  });
  refresh();
  return panel;
}
