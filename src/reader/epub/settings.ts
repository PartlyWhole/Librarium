/**
 * Reading settings for books (per device, through the reader store): what they are, how they
 * become Readium preferences, and the panel that changes them.
 */
import type { IEpubPreferences } from "@readium/navigator";
import { h } from "../../kit/dom";
import type { ReaderStore } from "../host";

export interface ReadingSettings {
  /** 1 = the book's size. */
  fontSize: number;
  font: "book" | "serif" | "sans";
  spacing: "book" | "tight" | "normal" | "loose";
  width: "narrow" | "medium" | "wide";
  layout: "pages" | "scroll";
  columns: "auto" | "one";
  theme: "auto" | "light" | "sepia" | "dark";
}

export const DEFAULT_SETTINGS: ReadingSettings = { fontSize: 1, font: "book", spacing: "book", width: "medium", layout: "pages", columns: "auto", theme: "auto" };

const FONTS = {
  serif: '"Iowan Old Style", "Palatino", "Charter", Georgia, serif',
  sans: '-apple-system, BlinkMacSystemFont, "Helvetica Neue", sans-serif',
};
const SPACING = { tight: 1.35, normal: 1.55, loose: 1.8 };
const WIDTH = { narrow: [45, 55, 65], medium: [50, 66, 80], wide: [60, 85, 100] } as const;
const THEMES = {
  light: { backgroundColor: "#fdfdfb", textColor: "#1d1d1f", linkColor: "#2a5db0" },
  sepia: { backgroundColor: "#f5edda", textColor: "#433422", linkColor: "#7a4a12" },
  dark: { backgroundColor: "#1c1c1e", textColor: "#dcdcdc", linkColor: "#8ab4f8" },
};

/** The saved settings, each value checked (anything unknown falls back to the default). */
export function readSettings(store: ReaderStore | undefined): ReadingSettings {
  const raw = (store?.get("reader.epub") ?? {}) as Partial<Record<keyof ReadingSettings, unknown>>;
  const pick = <K extends keyof ReadingSettings>(k: K, allowed: readonly ReadingSettings[K][]): ReadingSettings[K] =>
    (allowed as unknown[]).includes(raw[k]) ? (raw[k] as ReadingSettings[K]) : DEFAULT_SETTINGS[k];
  const size = typeof raw.fontSize === "number" && raw.fontSize >= 0.6 && raw.fontSize <= 2.5 ? raw.fontSize : 1;
  return {
    fontSize: size,
    font: pick("font", ["book", "serif", "sans"]),
    spacing: pick("spacing", ["book", "tight", "normal", "loose"]),
    width: pick("width", ["narrow", "medium", "wide"]),
    layout: pick("layout", ["pages", "scroll"]),
    columns: pick("columns", ["auto", "one"]),
    theme: pick("theme", ["auto", "light", "sepia", "dark"]),
  };
}

/** The app's own colours, for "follow the app". */
function appColors(): { backgroundColor: string; textColor: string; linkColor: string } {
  const cs = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback;
  const dark = document.documentElement.dataset.theme === "dark" || (document.documentElement.dataset.theme !== "light" && !!window.matchMedia?.("(prefers-color-scheme: dark)").matches);
  const base = dark ? THEMES.dark : THEMES.light;
  return { backgroundColor: v("--bg", base.backgroundColor), textColor: v("--ink", base.textColor), linkColor: v("--accent-text", base.linkColor) };
}

/** Settings as Readium preferences. */
export function toPreferences(s: ReadingSettings): IEpubPreferences {
  const [minimal, optimal, maximal] = WIDTH[s.width];
  const colors = s.theme === "auto" ? appColors() : THEMES[s.theme];
  return {
    fontSize: s.fontSize,
    fontFamily: s.font === "book" ? null : FONTS[s.font],
    lineHeight: s.spacing === "book" ? null : SPACING[s.spacing],
    minimalLineLength: minimal,
    optimalLineLength: optimal,
    maximalLineLength: maximal,
    scroll: s.layout === "scroll",
    columnCount: s.columns === "one" ? 1 : null,
    ...colors,
  };
}

/** The settings panel: a small dialog over the book. */
export function settingsPanel(s: ReadingSettings, apply: (s: ReadingSettings) => void, close: () => void, fixed: boolean): HTMLElement {
  let cur = s;
  const set = (patch: Partial<ReadingSettings>) => {
    cur = { ...cur, ...patch };
    apply(cur);
    refresh();
  };
  const choices = <K extends keyof ReadingSettings>(label: string, key: K, options: [ReadingSettings[K], string][]) => {
    const group = h("div", { class: "seg", role: "radiogroup", "aria-label": label },
      options.map(([value, text]) => h("button", { type: "button", role: "radio", "data-value": String(value), onclick: () => set({ [key]: value } as Partial<ReadingSettings>) }, text)));
    const row = h("div", { class: "epub-setting" }, h("span", { class: "epub-setting-label" }, label), group);
    return { row, group, key };
  };
  const size = h("output", { class: "epub-size", "aria-live": "polite" });
  const smaller = h("button", { type: "button", "aria-label": "Smaller text", onclick: () => set({ fontSize: Math.max(0.6, Math.round((cur.fontSize - 0.1) * 100) / 100) }) }, "A−");
  const larger = h("button", { type: "button", "aria-label": "Larger text", onclick: () => set({ fontSize: Math.min(2.5, Math.round((cur.fontSize + 0.1) * 100) / 100) }) }, "A+");
  const groups = [
    choices("Font", "font", [["book", "Book’s"], ["serif", "Serif"], ["sans", "Sans"]]),
    choices("Spacing", "spacing", [["book", "Book’s"], ["tight", "Tight"], ["normal", "Normal"], ["loose", "Loose"]]),
    choices("Line length", "width", [["narrow", "Narrow"], ["medium", "Medium"], ["wide", "Wide"]]),
    choices("Layout", "layout", [["pages", "Pages"], ["scroll", "Scroll"]]),
    choices("Columns", "columns", [["auto", "Two when wide"], ["one", "One"]]),
    choices("Theme", "theme", [["auto", "Follow app"], ["light", "Light"], ["sepia", "Sepia"], ["dark", "Dark"]]),
  ];
  const refresh = () => {
    size.textContent = `${Math.round(cur.fontSize * 100)}%`;
    for (const g of groups) for (const b of g.group.querySelectorAll<HTMLButtonElement>("button")) b.setAttribute("aria-checked", String(b.dataset.value === String(cur[g.key])));
    const columns = groups.find((g) => g.key === "columns")!;
    columns.row.hidden = cur.layout === "scroll";
  };
  const panel = h("div", { class: "epub-settings", role: "dialog", "aria-label": "Reading settings" },
    fixed
      ? h("p", { class: "muted small" }, "This book has fixed pages, so its text can’t be restyled.")
      : [h("div", { class: "epub-setting" }, h("span", { class: "epub-setting-label" }, "Text size"), h("div", { class: "seg" }, smaller, size, larger)), ...groups.filter((g) => g.key !== "theme").map((g) => g.row)],
    groups.find((g) => g.key === "theme")!.row,
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
