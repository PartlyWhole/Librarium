/**
 * The window's layout — ribbon, sidebar, tabs and header, the page, the side panel, the status
 * bar — and starting up: preferences, the library, the saved tabs.
 */
import { h, replace } from "../ui/dom";
import { iconButton } from "../ui/icon";
import { count } from "../ui/format";
import { effect, untracked } from "../ui/signal";
import { actionList, runAction, startActions } from "./actions";
import { defineGoActions, openToday, ribbon, sidebarOpen } from "./commands";
import { jobsStatus } from "./jobs";
import { isOpen, library, refreshLibrary, renderStart } from "./library";
import { guardLinks } from "./links";
import { fullPage, here, pages, type PageHandle } from "./pages";
import { panelOpen, sidePanel } from "./panel";
import { loadPrefs, pref } from "./prefs";
import { getRecord, loadRecords, records } from "./records";
import { placeOf, router, sameRoute, type Route, type SavedTabs } from "./router";
import { renderSettings } from "./settings";
import { context, message } from "./status";
import { sidebar } from "./sidebar";
import { recent, renderNewTab, tabBar } from "./tabs";
import { ChevronLeft, ChevronRight, Command, PanelLeft, PanelRight, Settings } from "lucide";
import "./theme.css";
import "./shell.css";
import "../ui/ui.css";

pages.settings = { title: "Settings", icon: Settings, render: renderSettings };
pages.newtab = { title: "New tab", icon: Command, render: (host) => renderNewTab(host, ribbon) };
pages.start = { title: "Welcome", icon: Command, render: renderStart };

/** A tab's page, kept alive (hidden) while another tab shows, so it keeps its place. */
interface Mounted {
  host: HTMLElement;
  page: string;
  route: Route;
  title: string;
  actions: Node[];
  scroll: number;
  here: { kind: string; folder: string } | null;
  dispose?: () => void;
  update?: (params: Record<string, string>) => boolean;
}

/** A button for an action, labelled with its title (or, for the Go pages, the page's name). */
const actionButton = (id: string, short = false) => {
  const a = actionList().find((x) => x.id === id)!;
  const b = iconButton(a.icon ?? Command, (short && a.menu?.title) || a.title, () => runAction(id), a.keys?.[0]);
  b.dataset.action = id;
  return b;
};

export function startApp(root: HTMLElement): void {
  defineGoActions();
  startActions();

  const ribbonButtons = ribbon.map((id) => actionButton(id, true));
  const nav = h("nav", { class: "ribbon", "aria-label": "Pages" },
    h("div", { class: "ribbon-group" }, iconButton(PanelLeft, "Toggle sidebar", () => runAction("app.toggleSidebar"), "Mod+\\")),
    h("div", { class: "ribbon-group" }, ribbonButtons),
    h("div", { class: "ribbon-spacer" }),
    h("div", { class: "ribbon-group" }, actionButton("app.palette"), actionButton("app.shortcuts"), actionButton("app.settings")));
  const side = sidebar();
  const back = iconButton(ChevronLeft, "Back", () => router.back(), "Mod+Alt+ArrowLeft");
  const fwd = iconButton(ChevronRight, "Forward", () => router.forward(), "Mod+Alt+ArrowRight");
  const titleEl = h("div", { class: "ws-title" });
  const headerActions = h("div", { class: "ws-actions" });
  const pageScroll = h("div", { class: "page-scroll" });
  const panelToggle = iconButton(PanelRight, "Toggle side panel", () => runAction("app.togglePanel"), "Mod+Alt+\\");
  const workspace = h("main", { class: "workspace" }, tabBar(), h("header", { class: "ws-header" }, h("div", { class: "ws-nav" }, back, fwd), titleEl, h("div", { class: "ws-end" }, headerActions, panelToggle)), pageScroll);
  const panel = sidePanel(() => (panelOpen.set(false), panelToggle.focus()));
  const statusLeft = h("div", { class: "status-left", role: "status", "aria-live": "polite" });
  const statusRight = h("div", { class: "status-right" });
  const app = h("div", { class: "app" }, nav, side, workspace, panel, h("footer", { class: "status-bar" }, h("div", { class: "status-group" }, statusLeft, jobsStatus()), statusRight));
  replace(root, app);
  guardLinks(() => titleEl.textContent || undefined);

  effect(() => {
    const full = fullPage();
    app.classList.toggle("full-page", full);
    app.classList.toggle("no-sidebar", !sidebarOpen() || full);
    app.classList.toggle("with-panel", panelOpen() && !full);
    side.hidden = !sidebarOpen() || full;
    panel.hidden = !panelOpen() || full;
    panelToggle.setAttribute("aria-pressed", String(panelOpen()));
  });
  effect(() => {
    back.disabled = !router.canBack();
    fwd.disabled = !router.canForward();
  });
  effect(() => {
    statusLeft.textContent = message();
    const st = library();
    const records_ = st?.state !== "open" ? "" : st.store?.phase === "checking" ? "Checking…" : count(records().size, "record");
    statusRight.textContent = [context(), records_].filter(Boolean).join("   ·   ");
  });
  // What was opened recently, for the New tab page.
  effect(() => {
    const id = router.current().params.id;
    if (id && getRecord(id)) untracked(() => recent.set([id, ...recent.peek().filter((x) => x !== id)].slice(0, 20)));
  });

  // ---- Pages, one per tab -------------------------------------------------------------------
  const mounted = new Map<string, Mounted>();
  let shownTab = "";
  const unmount = (id: string, m: Mounted) => {
    m.dispose?.();
    m.host.remove();
    mounted.delete(id);
  };
  const showTitle = (t: string) => {
    titleEl.textContent = t;
    document.title = t === "Welcome" ? "Librarium" : `${t} — Librarium`;
  };
  const mount = (tab: string, page: string, r: Route): Mounted => {
    const p = pages[page]!;
    const m: Mounted = { host: h("div", { class: "ws-page" }), page, route: r, title: p.title, actions: [], scroll: 0, here: null };
    pageScroll.appendChild(m.host);
    mounted.set(tab, m);
    router.setTitle(p.title, tab);
    const showing = () => router.active.peek() === tab;
    const made: PageHandle = p.render(m.host, r.params, {
      setTitle: (t) => {
        m.title = t;
        router.setTitle(t, tab);
        if (showing()) showTitle(t);
      },
      setHeaderActions: (nodes) => {
        m.actions = nodes;
        if (showing()) headerActions.replaceChildren(...nodes);
      },
    });
    if (typeof made === "function") m.dispose = made;
    else if (made) {
      m.dispose = made.dispose?.bind(made);
      m.update = made.update?.bind(made);
    }
    return m;
  };

  effect(() => {
    const r = router.current();
    const tab = router.active();
    const open = router.tabs();
    // Without a library, every page but Settings shows the start page.
    const page = !isOpen() && r.page !== "settings" ? "start" : r.page || "newtab";
    if (!pages[page]) return;
    untracked(() => {
      for (const [id, m] of mounted) if (!open.some((t) => t.id === id)) unmount(id, m);
      const leaving = shownTab !== tab ? mounted.get(shownTab) : undefined;
      if (leaving) {
        leaving.scroll = pageScroll.scrollTop;
        leaving.here = here.peek();
      }
      let m = mounted.get(tab);
      // The same record at another place: a page that can moves there without rendering again.
      if (m && m.page === page && m.update && m.route !== r && placeOf(m.route) === placeOf(r) && m.update(r.params)) {
        m.route = r;
        if (m.title) router.setTitle(m.title, tab);
      } else if (m && (m.page !== page || !sameRoute(m.route, r))) {
        unmount(tab, m);
        m = undefined;
      } else if (m) m.route = r;
      if (tab !== shownTab) {
        here.set(m?.here ?? null);
        context.set("");
      }
      m ??= mount(tab, page, r);
      for (const [id, x] of mounted) x.host.hidden = id !== tab;
      showTitle(m.title);
      headerActions.replaceChildren(...m.actions);
      for (const b of ribbonButtons) {
        const current = b.dataset.action === `go.${page}`;
        b.classList.toggle("current", current);
        if (current) b.setAttribute("aria-current", "page");
        else b.removeAttribute("aria-current");
      }
      if (tab !== shownTab) {
        const y = m.scroll;
        pageScroll.scrollTop = y;
        if (y) requestAnimationFrame(() => (pageScroll.scrollTop = y));
      }
      shownTab = tab;
    });
  });

  void start();
}

/** Loads the preferences and the library; once it is open, the saved tabs come back. */
async function start(): Promise<void> {
  const saved = pref<SavedTabs | null>("ui.tabs", null);
  await loadPrefs();
  // The saved tabs come back only when the saved library opens by itself at start; a library
  // chosen later (another one, or after the Welcome page) opens on Today.
  let wasOpen = false;
  let restore: boolean | undefined;
  effect(() => {
    const st = library();
    if (st) restore ??= st.state === "opening" || st.state === "open";
    const open = isOpen();
    if (open && !wasOpen) {
      const tabs = restore ? saved.peek() : undefined;
      restore = false;
      void untracked(() => opened(tabs));
    }
    wasOpen = open;
  });
  await refreshLibrary();
  // The tabs are kept for next time, once they are what the user left.
  let timer: ReturnType<typeof setTimeout> | undefined;
  effect(() => {
    router.tabs();
    router.active();
    clearTimeout(timer);
    timer = setTimeout(() => isOpen() && saved.set(router.save()), 500);
  });
}

/** With the library open: the saved tabs (`undefined` when they don't apply), else Today. */
async function opened(saved: SavedTabs | null | undefined): Promise<void> {
  await loadRecords();
  if (saved !== undefined && (router.current.peek().page !== "" || router.restore(saved))) return;
  await openToday();
}
