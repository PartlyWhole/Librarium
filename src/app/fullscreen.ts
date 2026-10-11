/**
 * Full screen for a page (a board, a PDF or saved page): the page fills the window, the rest of
 * the app is hidden, and the window goes into macOS full screen (and comes out only if it
 * wasn't there before). ⇧⌘↩ or the page's button turns it on and off; Escape or leaving the
 * page ends it.
 */
import { setWindowFullscreen } from "../backend";
import { h, replace } from "../ui/dom";
import { icon } from "../ui/icon";
import { effect, untracked } from "../ui/signal";
import { defineAction } from "./actions";
import { fullPage } from "./pages";
import { router, type Route } from "./router";
import { Maximize2, Minimize2 } from "lucide";

interface Toggle {
  here(r: Route): boolean;
  toggle(): void;
  busy?(): boolean;
}

/** The pages that can go full screen now, so the key finds the one shown. */
const toggles = new Set<Toggle>();

export interface FullScreen {
  /** The page's button for it (styled by the page). */
  button: HTMLButtonElement;
  toggle(): void;
  /** Ends it, and forgets the page (when the page goes). */
  stop(): void;
}

/** Full screen for the page that `here` says is shown; `focus` puts the keys back after, and
 * `busy` says when Escape has something else to do on the page first. */
export function fullScreen(here: (r: Route) => boolean, focus?: () => void, busy?: () => boolean): FullScreen {
  let on = false;
  let wasFullscreen = false;
  const button = h("button", { type: "button" });
  const show = () => {
    const label = on ? "Exit full screen" : "Full screen";
    button.setAttribute("aria-label", label);
    button.title = `${label} (⇧⌘↩)`;
    button.setAttribute("aria-pressed", String(on));
    replace(button, icon(on ? Minimize2 : Maximize2, 18));
  };
  const set = (to: boolean) => {
    if (to === on) return;
    on = to;
    fullPage.set(to);
    show();
    if (to) void setWindowFullscreen(true).then((was) => (wasFullscreen = was), () => {});
    else if (!wasFullscreen) void setWindowFullscreen(false).catch(() => {});
    focus?.();
  };
  const t: Toggle = { here, toggle: () => set(!on), busy };
  toggles.add(t);
  button.addEventListener("click", t.toggle);
  show();
  // Leaving the page (another page in its tab, or another tab) leaves full screen.
  const stopWatch = effect(() => {
    const r = router.current();
    if (!here(r)) untracked(() => set(false));
  });
  return {
    button,
    toggle: t.toggle,
    stop: () => {
      stopWatch();
      set(false);
      toggles.delete(t);
    },
  };
}

const shownIn = (r: Route) => [...toggles].find((t) => t.here(r));

// Escape ends it too, unless it is typed in a field (the find box, a board's text) or the page
// has something else to do with it. A board takes every Escape for itself, so this comes first.
window.addEventListener("keydown", (e) => {
  if (e.key !== "Escape" || !fullPage.peek()) return;
  const t = shownIn(router.current.peek());
  if (!t || t.busy?.() || (e.target as HTMLElement | null)?.closest("input, textarea, select, [contenteditable='true']")) return;
  t.toggle();
}, true);

defineAction({
  id: "app.fullscreen",
  get title() {
    return fullPage() ? "Exit full screen" : "Full screen";
  },
  keys: ["Mod+Shift+Enter"],
  reserved: true,
  when: () => !!shownIn(router.current()),
  run: () => shownIn(router.current.peek())?.toggle(),
  menu: { name: "view", group: 4, title: "Page in Full Screen" },
});
