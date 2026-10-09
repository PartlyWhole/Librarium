/**
 * The tab bar (the WAI-ARIA tabs pattern), as in Obsidian: a click shows a tab, a middle-click
 * or its × closes it, dragging moves it, and its context menu offers the rest. Also the New tab
 * page: where to go next, and what was opened recently.
 */
import { h, replace } from "../ui/dom";
import { icon, iconButton, type IconNode } from "../ui/icon";
import { display } from "../ui/keys";
import { contextMenu, isMenuKey, menuPointFor, type MenuItem, type Point } from "../ui/menu";
import { effect } from "../ui/signal";
import { actionList, runAction } from "./actions";
import { pages } from "./pages";
import { pref } from "./prefs";
import { getRecord, isArchived, openRecord, recordIcon } from "./records";
import { router, type Route } from "./router";
import { FileText, Plus, X } from "lucide";

/** What was opened recently, newest first (for the New tab page). */
export const recent = pref<string[]>("ui.recent", []);

function iconOf(r: Route): IconNode {
  const rec = getRecord(r.params.id);
  return rec ? recordIcon(rec) : pages[r.page]?.icon ?? FileText;
}

export function tabBar(): HTMLElement {
  const list = h("div", { class: "tab-list", role: "tablist", "aria-label": "Tabs" });
  const bar = h("div", { class: "tab-bar" }, list, iconButton(Plus, "New tab", () => router.newTab(), "Mod+T", 15));
  bar.lastElementChild!.classList.add("tab-new");
  let dragged = false;

  const menu = (id: string, i: number, at: Point) => {
    const n = router.tabs.peek().length;
    const items: MenuItem[] = [{ label: "Close", run: () => router.close(id) }];
    if (n > 1) items.push({ label: "Close other tabs", run: () => router.closeOthers(id) });
    items.push("separator", { label: "New tab", run: () => router.newTab() });
    if (i > 0) items.push({ label: "Move left", run: () => router.move(id, i - 1) });
    if (i < n - 1) items.push({ label: "Move right", run: () => router.move(id, i + 1) });
    contextMenu(items, at, "Tab");
  };

  // Dragging a tab along the bar moves it.
  const startDrag = (e: PointerEvent, id: string) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest(".tab-close")) return;
    const x0 = e.clientX;
    dragged = false;
    let to = -1;
    const tabsEls = () => [...list.querySelectorAll<HTMLElement>(".tab")];
    const mark = (i: number) => {
      for (const t of tabsEls()) t.classList.remove("drop-before", "drop-after");
      const ts = tabsEls();
      if (i >= 0 && i < ts.length) ts[i]!.classList.add("drop-before");
      else if (i >= ts.length) ts.at(-1)?.classList.add("drop-after");
    };
    const move = (m: PointerEvent) => {
      if (!dragged && Math.abs(m.clientX - x0) < 6) return;
      dragged = true;
      const ts = tabsEls();
      to = ts.findIndex((t) => m.clientX < t.getBoundingClientRect().left + t.offsetWidth / 2);
      if (to < 0) to = ts.length;
      mark(to);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      mark(-1);
      if (dragged && to >= 0) {
        const from = router.tabs.peek().findIndex((t) => t.id === id);
        router.move(id, to > from ? to - 1 : to);
      }
      // The click that ends a drag isn't a click.
      setTimeout(() => (dragged = false), 0);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  effect(() => {
    const tabs = router.tabs();
    const active = router.active();
    const hadFocus = list.contains(document.activeElement);
    replace(list, tabs.map((t, i) => {
      const title = t.title || pages[t.route.page]?.title || "New tab";
      const on = t.id === active;
      // For the pointer only: the keyboard closes with ⌘W or Delete.
      const close = h("span", { class: "tab-close", "aria-hidden": "true", title: `Close tab (${display("Mod+W")})` }, icon(X, 12));
      close.addEventListener("click", (e) => (e.stopPropagation(), router.close(t.id)));
      const el = h("div", { class: `tab${on ? " active" : ""}`, role: "tab", "aria-selected": String(on), tabindex: on ? "0" : "-1", title, dataset: { id: t.id } }, icon(iconOf(t.route), 14), h("span", { class: "tab-title" }, title), close);
      el.addEventListener("click", () => !dragged && router.select(t.id));
      el.addEventListener("mousedown", (e) => e.button === 1 && e.preventDefault());
      el.addEventListener("auxclick", (e) => e.button === 1 && (e.preventDefault(), router.close(t.id)));
      el.addEventListener("contextmenu", (e) => (e.preventDefault(), menu(t.id, i, { x: e.clientX, y: e.clientY })));
      el.addEventListener("pointerdown", (e) => startDrag(e, t.id));
      el.addEventListener("keydown", (e) => {
        const n = tabs.length;
        const to = ({ ArrowRight: (i + 1) % n, ArrowLeft: (i - 1 + n) % n, Home: 0, End: n - 1 } as Record<string, number>)[e.key];
        if (to !== undefined) router.select(to);
        else if (e.key === "Delete" || e.key === "Backspace") router.close(t.id);
        else if (isMenuKey(e)) menu(t.id, i, menuPointFor(el));
        else return;
        e.preventDefault();
      });
      return el;
    }));
    const cur = list.querySelector<HTMLElement>(".tab.active");
    cur?.scrollIntoView({ block: "nearest", inline: "nearest" });
    if (hadFocus) cur?.focus({ preventScroll: true });
  });
  return bar;
}

/** The New tab page; `ribbon` lists the actions of the ribbon's pages. */
export function renderNewTab(host: HTMLElement, ribbon: string[]): () => void {
  const link = (label: string, keys: string | undefined, run: () => void, node?: IconNode) =>
    h("li", null, h("button", { class: "newtab-link", type: "button", onclick: run }, node ? icon(node, 16) : null, h("span", null, label), keys ? h("kbd", { class: "muted small" }, display(keys)) : null));
  return effect(() => {
    const goes = ribbon.map((id) => actionList().find((a) => a.id === id)!);
    const items = recent().map((id) => getRecord(id)).filter((r) => !!r && !isArchived(r)).slice(0, 10);
    replace(host,
      h("h1", { class: "page-title" }, "New tab"),
      h("ul", { class: "newtab-list" },
        link("Open a note or library item…", "Mod+O", () => runAction("app.open")),
        goes.map((a) => link(a.menu?.title ?? a.title, a.keys?.[0], () => runAction(a.id), a.icon)),
      ),
      items.length ? [h("h2", { class: "list-heading" }, "Opened recently"), h("ul", { class: "newtab-list" }, items.map((r) => link(r!.title || "Untitled", undefined, () => openRecord(r!.id), recordIcon(r!))))] : null,
    );
  });
}
