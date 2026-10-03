/**
 * Tabs, as in Obsidian: a bar above the page (the WAI-ARIA tabs pattern), each tab a place
 * with its own history. A click shows a tab, a middle-click or its × closes it, a drag along
 * the bar moves it, and its context menu offers the rest. The "New tab" page offers where to
 * go, and what was opened recently.
 */
import { h, replace } from "../kit/dom";
import { icon, type IconNode } from "../kit/icon";
import { effect } from "../kit/signal";
import { contextMenu, menuPointFor } from "../kit/menu";
import { display } from "../kit/keys";
import type { Router, Route } from "./router";
import type { Page, ShellApi } from "./slots";
import { FileText, Plus, X } from "lucide";

/** The tab bar. `pageOf` gives the page a route shows (for its icon and default title). */
export function tabBar(router: Router, pageOf: (r: Route) => Page | undefined, iconOf: (r: Route) => IconNode | undefined): HTMLElement {
  const list = h("div", { class: "tab-list", role: "tablist", "aria-label": "Tabs" });
  const add = h("button", { class: "icon-button tab-new", type: "button", "aria-label": "New tab", title: `New tab (${display("Mod+T")})`, onclick: () => router.newTab() }, icon(Plus, 15));
  const bar = h("div", { class: "tab-bar" }, list, add);
  let dragged = false;

  effect(() => {
    const tabs = router.tabs();
    const active = router.active();
    const hadFocus = list.contains(document.activeElement);
    replace(list, tabs.map((t, i) => {
      const p = pageOf(t.route);
      const title = t.title || p?.title || "New tab";
      const on = t.id === active;
      // For the pointer only (no control inside a tab): the keyboard closes with ⌘W or Delete.
      const close = h("span", { class: "tab-close", "aria-hidden": "true", title: `Close tab (${display("Mod+W")})` }, icon(X, 12));
      const el = h("div", { class: `tab${on ? " active" : ""}`, role: "tab", "aria-selected": String(on), tabindex: on ? "0" : "-1", title, dataset: { id: t.id } },
        icon(iconOf(t.route) ?? p?.icon ?? FileText, 14),
        h("span", { class: "tab-title" }, title),
        close,
      );
      close.addEventListener("click", (e) => {
        e.stopPropagation();
        router.close(t.id);
      });
      el.addEventListener("click", () => {
        if (dragged) return;
        router.select(t.id);
      });
      // A middle-click closes it, as in a browser.
      el.addEventListener("auxclick", (e) => {
        if (e.button !== 1) return;
        e.preventDefault();
        router.close(t.id);
      });
      el.addEventListener("mousedown", (e) => e.button === 1 && e.preventDefault());
      el.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        menu(t.id, i, { x: e.clientX, y: e.clientY });
      });
      el.addEventListener("keydown", (e) => {
        const n = tabs.length;
        const to = e.key === "ArrowRight" ? (i + 1) % n : e.key === "ArrowLeft" ? (i - 1 + n) % n : e.key === "Home" ? 0 : e.key === "End" ? n - 1 : -1;
        if (to >= 0) {
          e.preventDefault();
          router.select(to);
        } else if (e.key === "Delete" || e.key === "Backspace") {
          e.preventDefault();
          router.close(t.id);
        } else if (e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey)) {
          e.preventDefault();
          menu(t.id, i, menuPointFor(el));
        }
      });
      el.addEventListener("pointerdown", (e) => startDrag(e, t.id));
      return el;
    }));
    const cur = list.querySelector<HTMLElement>(".tab.active");
    cur?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
    if (hadFocus) cur?.focus({ preventScroll: true });
  });

  const menu = (id: string, i: number, at: { x: number; y: number }) => {
    const n = router.tabs.peek().length;
    contextMenu([
      { label: "Close", run: () => router.close(id) },
      ...(n > 1 ? [{ label: "Close other tabs", run: () => router.closeOthers(id) }] : []),
      "separator",
      { label: "New tab", run: () => router.newTab() },
      ...(i > 0 ? [{ label: "Move left", run: () => router.move(id, i - 1) }] : []),
      ...(i < n - 1 ? [{ label: "Move right", run: () => router.move(id, i + 1) }] : []),
    ], at, "Tab");
  };

  // Dragging a tab along the bar moves it.
  const startDrag = (e: PointerEvent, id: string) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest(".tab-close")) return;
    const x0 = e.clientX;
    dragged = false;
    let to = -1;
    const mark = (i: number) => {
      list.querySelectorAll(".drop-before, .drop-after").forEach((x) => x.classList.remove("drop-before", "drop-after"));
      const tabs = [...list.querySelectorAll<HTMLElement>(".tab")];
      if (i < 0) return;
      if (i < tabs.length) tabs[i]!.classList.add("drop-before");
      else tabs[tabs.length - 1]?.classList.add("drop-after");
    };
    const move = (m: PointerEvent) => {
      if (!dragged && Math.abs(m.clientX - x0) < 6) return;
      dragged = true;
      const tabs = [...list.querySelectorAll<HTMLElement>(".tab")];
      to = tabs.findIndex((t) => {
        const r = t.getBoundingClientRect();
        return m.clientX < r.left + r.width / 2;
      });
      if (to < 0) to = tabs.length;
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

  return bar;
}

/** The "New tab" page: where to go next, and what was opened recently. */
export function renderNewTab(shell: ShellApi, host: HTMLElement, recent: () => string[]): () => void {
  const stop = effect(() => {
    const go = (label: string, keys: string | undefined, run: () => void, node?: IconNode) =>
      h("li", null, h("button", { class: "newtab-link", type: "button", onclick: run }, node ? icon(node, 16) : null, h("span", null, label), keys ? h("kbd", { class: "muted small" }, display(keys)) : null));
    const pages = shell.pages.values().filter((p) => p.ribbon !== undefined).sort((a, b) => a.ribbon! - b.ribbon!);
    const items = recent().map((id) => shell.records.get(id)).filter((r): r is NonNullable<typeof r> => !!r && !shell.records.isHidden(r)).slice(0, 10);
    replace(host,
      h("h1", { class: "page-title" }, "New tab"),
      h("ul", { class: "newtab-list" },
        go("Open a note or library item…", "Mod+O", () => shell.actions.run("shell.open")),
        pages.map((p) => go(p.title, p.keys, () => shell.router.go(p.id, {}, { replace: true }), p.icon)),
      ),
      items.length ? [h("h2", { class: "list-heading" }, "Opened recently"), h("ul", { class: "newtab-list" }, items.map((r) => go(r.title || "Untitled", undefined, () => shell.openRecord(r.id), shell.looks.get(r.kind)?.icon(r))))] : null,
    );
  });
  return stop;
}
