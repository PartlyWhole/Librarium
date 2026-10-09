/**
 * What surrounds a book's page: the reading settings and the toolbar's popovers (Contents and
 * the Aa panel, and a footnote's popover), "N pages left in chapter", the page's colour reaching
 * the edges, and the side arrows that show while the pointer moves.
 */
import { EpubPreferences } from "@readium/navigator";
import { List } from "lucide";
import { pref } from "../../app/prefs";
import { h } from "../../ui/dom";
import { icon } from "../../ui/icon";
import { pathOf, type BookView, type Places } from "./places";
import { settingsPanel, readSettings, themeOf, THEMES, toPreferences, type ReadingSettings } from "./settings";

type Popover = { kind: "contents" | "settings" | "note"; el: HTMLElement; anchor: HTMLElement };

/**
 * `frame` is the book's whole area, `left` the foot's "pages left" line; `goHref` goes to a
 * place in the book; `chromeWatchers` hear when a popover wants the toolbar shown.
 */
export function bookChrome(b: BookView, p: Places, o: { frame: HTMLElement; left: HTMLElement; goHref: (href: string) => void; chromeWatchers: Set<(wanted: boolean) => void> }) {
  const { book, stage } = b;
  const { frame, left } = o;
  const settingsPref = pref<unknown>("reader.epub", null);
  let settings = readSettings(settingsPref.peek());
  let popover: Popover | null = null;

  const contentsBtn = h("button", { class: "icon-button", type: "button", title: "Contents", "aria-label": "Contents", "aria-expanded": "false", onclick: () => togglePopover("contents") }, icon(List));
  contentsBtn.hidden = !book.toc.length;
  const aa = h("button", { class: "epub-aa", type: "button", title: "Reading settings", "aria-label": "Reading settings", "aria-expanded": "false", onclick: () => togglePopover("settings") }, "Aa");

  // Pages left in this chapter, from the layout (columns across the frame), as Books says it.
  function showLeft() {
    left.textContent = "";
    const current = b.current();
    if (b.scrolling() || book.fixed || !current) return;
    const f = b.visible(pathOf(current));
    const w = f?.el.clientWidth ?? 0;
    if (!f || !w) return;
    const el = f.doc.scrollingElement ?? f.doc.documentElement;
    const total = Math.max(1, Math.round(el.scrollWidth / w));
    const at = Math.min(total - 1, el.scrollLeft > 0 ? Math.round(el.scrollLeft / w) : Math.round((current.locations.progression ?? 0) * total));
    const n = total - 1 - at;
    left.textContent = n === 0 ? "Last page in chapter" : n === 1 ? "1 page left in chapter" : `${n} pages left in chapter`;
  }
  // The page's colour reaches the edges, as in Books (head, foot and margins share it).
  function paintChrome() {
    const t = THEMES[themeOf(settings)];
    frame.style.setProperty("--book-bg", t.backgroundColor);
    frame.style.setProperty("--book-muted", `color-mix(in srgb, ${t.textColor} 55%, transparent)`);
  }
  paintChrome();
  let resizeTimer: ReturnType<typeof setTimeout> | undefined;
  const resized = new ResizeObserver(() => {
    showLeft();
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => (showLeft(), popover?.el.dispatchEvent(new CustomEvent("laidout", { detail: settings }))), 300);
  });
  resized.observe(stage);
  // The arrows show while the pointer moves, then fade.
  let stillTimer: ReturnType<typeof setTimeout> | undefined;
  function stirred() {
    frame.classList.add("stirred");
    clearTimeout(stillTimer);
    stillTimer = setTimeout(() => frame.classList.remove("stirred"), 1800);
  }
  frame.addEventListener("mousemove", stirred);

  // ---- The reading settings, and the popovers from the toolbar ------------------------------
  const apply = (next: ReadingSettings) => {
    // A new layout keeps the first words on screen (Readium keeps only the chapter's
    // progression, a page or more off between pages and scrolling).
    const keep = next.layout !== settings.layout ? p.wordsShown() : null;
    settings = next;
    settingsPref.set(settings);
    paintChrome();
    void b.nav().submitPreferences(new EpubPreferences(toPreferences(settings))).then(async () => {
      if (keep) {
        await new Promise((r) => setTimeout(r, 120));
        await p.showCfi(keep, null, false);
      }
      setTimeout(() => {
        showLeft();
        popover?.el.dispatchEvent(new CustomEvent("laidout", { detail: settings }));
      }, 120);
    });
  };
  /** How many pages are side by side now (1 or 2), or null when scrolling. */
  function pagesShown(): number | null {
    if (b.scrolling() || book.fixed) return null;
    const f = b.frames().find((x) => x.index >= 0 && x.el.style.visibility !== "hidden");
    const n = f ? Number.parseInt(getComputedStyle(f.doc.documentElement).columnCount, 10) : NaN;
    return Number.isFinite(n) ? n : null;
  }
  function closePopover() {
    if (!popover) return;
    popover.el.remove();
    if (popover.kind !== "note") popover.anchor.setAttribute("aria-expanded", "false");
    popover = null;
    o.chromeWatchers.forEach((cb) => cb(false));
  }
  function togglePopover(kind: "contents" | "settings") {
    const was = popover?.kind;
    closePopover();
    if (was === kind) return;
    const anchor = kind === "contents" ? contentsBtn : aa;
    const el = kind === "contents" ? contentsList() : settingsPanel(settings, apply, closePopover, book.fixed, pagesShown);
    document.body.appendChild(el);
    const r = anchor.getBoundingClientRect();
    el.style.top = `${Math.round(r.bottom + 6)}px`;
    if (kind === "contents") el.style.left = `${Math.max(8, Math.round(r.left))}px`;
    else el.style.right = `${Math.max(8, Math.round(window.innerWidth - r.right))}px`;
    popover = { kind, el, anchor };
    anchor.setAttribute("aria-expanded", "true");
    o.chromeWatchers.forEach((cb) => cb(true));
    (el.querySelector<HTMLElement>("[aria-current=true]") ?? el.querySelector<HTMLElement>("button"))?.focus();
  }
  function contentsList(): HTMLElement {
    const current = b.current();
    const here = current ? book.toc.find((t) => t.href.split("#")[0] === pathOf(current))?.href : undefined;
    const el = h("div", { class: "epub-popover epub-toc", role: "dialog", "aria-label": "Contents" },
      h("div", { class: "epub-toc-title" }, book.title),
      h("ul", { class: "epub-toc-list" }, book.toc.map((t) => h("li", null, h("button", { type: "button", class: "epub-toc-item", style: `padding-left: ${12 + t.depth * 16}px`, "aria-current": t.href === here ? "true" : undefined, onclick: () => (closePopover(), o.goHref(t.href)) }, t.title)))));
    el.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        closePopover();
        contentsBtn.focus();
      } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        const items = [...el.querySelectorAll<HTMLElement>(".epub-toc-item")];
        const i = items.indexOf(document.activeElement as HTMLElement);
        items[Math.max(0, Math.min(items.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)))]?.focus();
        e.preventDefault();
      }
    });
    return el;
  }
  const onAway = (e: MouseEvent) => {
    if (popover && !popover.el.contains(e.target as Node) && !popover.anchor.contains(e.target as Node)) closePopover();
  };
  window.addEventListener("mousedown", onAway, true);
  // "Match the app" follows the app's theme as it changes.
  const themeWatch = new MutationObserver(() => settings.matchApp && apply(settings));
  themeWatch.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  const media = window.matchMedia?.("(prefers-color-scheme: dark)");
  const onScheme = () => settings.matchApp && apply(settings);
  media?.addEventListener?.("change", onScheme);

  return {
    contentsBtn,
    aa,
    settings: () => settings,
    apply,
    showLeft,
    stirred,
    closePopover,
    /** Shows a footnote's popover (already placed), as the popover open now. */
    showNote(el: HTMLElement) {
      popover = { kind: "note", el, anchor: frame };
      o.chromeWatchers.forEach((cb) => cb(true));
    },
    destroy() {
      clearTimeout(resizeTimer);
      clearTimeout(stillTimer);
      themeWatch.disconnect();
      resized.disconnect();
      closePopover();
      window.removeEventListener("mousedown", onAway, true);
      media?.removeEventListener?.("change", onScheme);
    },
  };
}
