/**
 * The shell: layout, router, action and key registry, native menu, prefs, settings, first run.
 * Features contribute through the registries; the shell never imports a feature.
 */
import { call, on, onCloseRequested, pickFolder } from "../backend";
import { Undo } from "./undo";
import { jobsUi } from "./jobs";
import type { EditorContribution } from "../editor/editor";
import type { ReaderEngine } from "../reader/host";
import { ask, modal } from "../kit/dialog";
import { h, replace } from "../kit/dom";
import { comboboxDialog } from "../kit/combobox";
import { count } from "../kit/format";
import { icon, type IconNode } from "../kit/icon";
import { display, fromEvent } from "../kit/keys";
import { Registry } from "../kit/registry";
import { batch, effect, signal, untracked } from "../kit/signal";
import { Tree, type TreeNode } from "../kit/tree";
import { toast } from "../kit/toast";
import type { FolderInfo } from "../generated/FolderInfo";
import type { LibraryStatus } from "../generated/LibraryStatus";
import { Actions, type Action } from "./actions";
import type { ShellApi, StatusBar } from "./api";
import { refreshMenu } from "./menu";
import { Prefs } from "./prefs";
import { Records } from "./records";
import { Router } from "./router";
import type { EmbedRenderer, Page, RecordAction, SettingsSection, SidebarSection, SidePanelSection } from "./slots";
import { contextMenu, type MenuItem } from "../kit/menu";
import { PanelLeft, PanelRight, ChevronLeft, ChevronRight, Command, Keyboard, Settings, FolderOpen } from "lucide";

export type Feature = (shell: ShellApi) => void;

export interface Shell extends ShellApi {
  /** Startup timings, for the performance budgets. */
  timings: Record<string, number>;
  /** Removes the shell's global listeners (tests build many shells). */
  destroy(): void;
}

function iconButton(node: IconNode, label: string, run: () => void, keys?: string): HTMLButtonElement {
  const tip = keys ? `${label} (${display(keys)})` : label;
  return h("button", { class: "icon-button", type: "button", "aria-label": label, title: tip, onclick: run }, icon(node));
}

/** Builds the shell, lets every feature contribute, then starts. */
export function createShell(root: HTMLElement, features: Feature[]): Shell {
  const t0 = performance.now();
  const actions = new Actions();
  const pages = new Registry<Page>("shell.pages");
  const sidebar = new Registry<SidebarSection>("shell.sidebar-sections");
  const sidePanel = new Registry<SidePanelSection>("shell.side-panel-sections");
  const settings = new Registry<SettingsSection>("shell.settings-sections");
  const openers = new Registry<string>("shell.openers");
  const editorExtensions = new Registry<EditorContribution>("shell.editor-extensions");
  const readerEngines = new Registry<ReaderEngine>("shell.reader-engines");
  const embeds = new Registry<EmbedRenderer>("shell.embeds");
  const undo = new Undo();
  const closing = new Set<() => Promise<void>>();
  onCloseRequested(async () => {
    await Promise.allSettled([...closing].map((f) => f()));
    await prefs.flush();
  });
  const slots = new Map<string, Registry<unknown>>();
  const router = new Router();
  const prefs = new Prefs();
  const hidingFields = new Registry<string>("shell.hiding-fields");
  const recordActions = new Registry<RecordAction>("shell.record-actions");
  const records = new Records(() => hidingFields.values());
  const folder = signal<LibraryStatus | null>(null);
  const indexed = signal(0);
  on("event.indexed", (p) => indexed.set((p as { seq: number }).seq));
  const message = signal("");
  const right = signal("");
  let msgTimer: ReturnType<typeof setTimeout> | undefined;
  const status: StatusBar = {
    message,
    right,
    show(text, ms = 4000) {
      clearTimeout(msgTimer);
      message.set(text);
      if (ms > 0) msgTimer = setTimeout(() => message.set(""), ms);
    },
  };

  const shell: Shell = {
    actions,
    pages,
    sidebar,
    sidePanel,
    settings,
    openers,
    hidingFields,
    recordActions,
    showRecordMenu(target, at) {
      const rs = Array.isArray(target) ? target : [target];
      if (!rs.length) return;
      const items: MenuItem[] = [];
      const one = rs.length === 1 ? rs[0]! : null;
      if (one && openers.get(one.kind)) items.push({ label: "Open", run: () => shell.openRecord(one.id) });
      const extra = recordActions
        .values()
        .map((a) => ({ a, on: a.partial ? rs.filter((r) => a.applies(r)) : rs.every((r) => a.applies(r)) ? rs : [] }))
        .filter((x) => x.on.length)
        // Destructive entries go last.
        .sort((x, y) => Number(!!x.a.destructive) - Number(!!y.a.destructive));
      if (items.length && extra.length) items.push("separator");
      for (const { a, on } of extra) items.push({ label: typeof a.label === "function" ? a.label(on.length) : a.label, destructive: a.destructive, run: () => void a.run(on) });
      if (items.length) contextMenu(items, at, one ? one.title || "Untitled" : `${rs.length} items`);
    },
    slot<T>(id: string) {
      let r = slots.get(id);
      if (!r) slots.set(id, (r = new Registry<unknown>(id)));
      return r as Registry<T>;
    },
    router,
    prefs,
    records,
    status,
    folder,
    openRecord(id, params = {}) {
      const r = records.get(id);
      const page = r ? openers.get(r.kind) : undefined;
      if (page) router.go(page, { id, ...params });
      else status.show("That record can't be opened here.");
    },
    editorExtensions,
    readerEngines,
    embeds,
    undo,
    indexed,
    beforeClose(fn) {
      closing.add(fn);
      return () => closing.delete(fn);
    },
    timings: {},
    destroy: () => {
      document.removeEventListener("keydown", onKey, true);
      destroyed = true;
      if (typeof dispose === "function") dispose();
      dispose = undefined;
    },
  };

  // The current page's disposer.
  let dispose: (() => void) | void;
  let lastPage = "";

  // ---- core actions -------------------------------------------------------------------
  let destroyed = false;
  const sidebarOpen = prefs.pref("ui.sidebar", true);
  const panelOpen = prefs.pref("ui.sidePanel", false);
  const libraryOpen = () => folder()?.state === "open";
  const core: Action[] = [
    { id: "shell.palette", title: "Command palette", keys: ["Mod+Shift+P"], reserved: true, palette: false, run: () => openPalette(), menu: { name: "view", group: 0 }, icon: Command },
    { id: "shell.open", title: "Open a note or library item…", keys: ["Mod+O"], reserved: true, when: libraryOpen, run: () => openQuick(), menu: { name: "file", group: 1, title: "Open…" } },
    { id: "shell.shortcuts", title: "Keyboard shortcuts", keys: ["Mod+/"], reserved: true, run: () => openShortcuts(), menu: { name: "help", group: 0 }, icon: Keyboard },
    { id: "shell.settings", title: "Settings", keys: ["Mod+,"], reserved: true, run: () => router.go("settings"), menu: { name: "app", group: 0, title: "Settings…" }, icon: Settings },
    { id: "shell.toggleSidebar", title: "Toggle sidebar", keys: ["Mod+\\"], reserved: true, run: () => sidebarOpen.update((v) => !v), menu: { name: "view", group: 1 }, icon: PanelLeft },
    { id: "shell.toggleSidePanel", title: "Toggle side panel", keys: ["Mod+Alt+\\"], reserved: true, run: () => panelOpen.update((v) => !v), menu: { name: "view", group: 1 }, icon: PanelRight },
    { id: "shell.back", title: "Back", keys: ["Mod+Alt+ArrowLeft"], reserved: true, when: () => router.canBack(), run: () => router.back(), menu: { name: "go", group: 9 } },
    { id: "shell.forward", title: "Forward", keys: ["Mod+Alt+ArrowRight"], reserved: true, when: () => router.canForward(), run: () => router.forward(), menu: { name: "go", group: 9 } },
    { id: "shell.chooseFolder", title: "Choose library folder…", run: () => void chooseFolder(), menu: { name: "file", group: 8 }, icon: FolderOpen },
    { id: "shell.revealFolder", title: "Show library folder in Finder", when: libraryOpen, run: () => void call("folder.reveal").catch(report), menu: { name: "file", group: 8 } },
    { id: "shell.revealLogs", title: "Reveal logs", run: () => void call("app.revealLogs").catch(report), menu: { name: "help", group: 1 } },
    { id: "shell.undo", title: "Undo the last rename or move", when: () => undo.last() !== null, run: () => void undo.undoLast(), menu: { name: "edit", group: 1 } },
    { id: "shell.theme.system", title: "Theme: follow the system", run: () => prefs.pref("ui.theme", "system").set("system"), menu: { name: "view", group: 2 } },
    { id: "shell.theme.light", title: "Theme: light", run: () => prefs.pref("ui.theme", "system").set("light"), menu: { name: "view", group: 2 } },
    { id: "shell.theme.dark", title: "Theme: dark", run: () => prefs.pref("ui.theme", "system").set("dark"), menu: { name: "view", group: 2 } },
  ];
  for (const a of core) actions.add("shell", a);
  pages.add("shell", "settings", { id: "settings", title: "Settings", icon: Settings, render: (host) => renderSettings(host) }, 100);
  pages.add("shell", "welcome", { id: "welcome", title: "Welcome", icon: FolderOpen, render: (host) => renderWelcome(host) }, 101);

  // ---- features contribute ------------------------------------------------------------
  jobsUi(shell);
  for (const f of features) f(shell);
  for (const p of pages.values()) {
    if (p.keys || p.ribbon !== undefined) {
      actions.add(`page:${p.id}`, { id: `go.${p.id}`, title: `Go to ${p.title}`, keys: p.keys ? [p.keys] : undefined, reserved: true, when: () => libraryOpen(), run: () => router.go(p.id), menu: { name: "go", group: 0, title: p.title }, icon: p.icon });
    }
  }

  // ---- layout -------------------------------------------------------------------------
  const ribbonPages = pages.values().filter((p) => p.ribbon !== undefined).sort((a, b) => a.ribbon! - b.ribbon!);
  const ribbonTop = h("div", { class: "ribbon-group" }, iconButton(PanelLeft, "Toggle sidebar", () => actions.run("shell.toggleSidebar"), "Mod+\\"));
  const ribbonPageButtons = ribbonPages.map((p) => {
    const b = iconButton(p.icon, p.title, () => actions.run(`go.${p.id}`), p.keys);
    b.dataset.page = p.id;
    return b;
  });
  const ribbon = h(
    "nav",
    { class: "ribbon", "aria-label": "Pages" },
    ribbonTop,
    h("div", { class: "ribbon-group" }, ribbonPageButtons),
    h("div", { class: "ribbon-spacer" }),
    h("div", { class: "ribbon-group" }, iconButton(Command, "Command palette", () => actions.run("shell.palette"), "Mod+Shift+P"), iconButton(Keyboard, "Keyboard shortcuts", () => actions.run("shell.shortcuts"), "Mod+/"), iconButton(Settings, "Settings", () => actions.run("shell.settings"), "Mod+,")),
  );

  const folded = prefs.pref<string[]>("ui.folded", []);
  const filter = h("input", { class: "sidebar-filter", type: "search", placeholder: "Filter", "aria-label": "Filter the sidebar", spellcheck: false });
  const filterText = signal("");
  filter.addEventListener("input", () => filterText.set(filter.value));
  const tree = new Tree("Notes and library", (id, expanded) => folded.update((f) => (expanded ? f.filter((x) => x !== id) : [...new Set([...f, id])])));
  // A record's row in the sidebar has the record's menu.
  tree.onContext = (ids, at) => {
    const rs = ids.map((id) => records.get(id)).filter((r): r is NonNullable<typeof r> => !!r);
    if (rs.length) shell.showRecordMenu(rs, at);
  };
  const sidebarEl = h("aside", { class: "app-sidebar", "aria-label": "Sidebar" }, h("div", { class: "sidebar-top" }, filter), h("div", { class: "sidebar-scroll" }, tree.el));

  const back = iconButton(ChevronLeft, "Back", () => router.back(), "Mod+Alt+ArrowLeft");
  const fwd = iconButton(ChevronRight, "Forward", () => router.forward(), "Mod+Alt+ArrowRight");
  const titleEl = h("div", { class: "ws-title" });
  const headerActions = h("div", { class: "ws-actions" });
  const pageHost = h("div", { class: "ws-page" });
  const pageScroll = h("div", { class: "page-scroll" }, pageHost);
  const workspace = h("main", { class: "workspace" }, h("header", { class: "ws-header" }, h("div", { class: "ws-nav" }, back, fwd), titleEl, headerActions), pageScroll);
  const panelEl = h("aside", { class: "side-panel", "aria-label": "Side panel" });
  const statusLeft = h("div", { class: "status-left", role: "status", "aria-live": "polite" });
  const statusJobs = h("div", { class: "status-jobs", role: "status", "aria-live": "polite" });
  const statusRight = h("div", { class: "status-right" });
  const statusBar = h("footer", { class: "status-bar" }, h("div", { class: "status-group" }, statusLeft, statusJobs), statusRight);
  const app = h("div", { class: "app" }, ribbon, sidebarEl, workspace, panelEl, statusBar);
  replace(root, app);

  // ---- reactive wiring ----------------------------------------------------------------
  effect(() => {
    app.classList.toggle("no-sidebar", !sidebarOpen());
    app.classList.toggle("with-panel", panelOpen());
    sidebarEl.hidden = !sidebarOpen();
    panelEl.hidden = !panelOpen();
  });
  const theme = prefs.pref("ui.theme", "system");
  effect(() => {
    const t = theme();
    if (t === "light" || t === "dark") document.documentElement.dataset.theme = t;
    else delete document.documentElement.dataset.theme;
  });
  const textSize = prefs.pref("ui.textSize", 16);
  effect(() => document.documentElement.style.setProperty("--reading-size", `${textSize()}px`));
  effect(() => {
    statusLeft.textContent = message();
    statusRight.textContent = right();
  });
  effect(() => {
    back.disabled = !router.canBack();
    fwd.disabled = !router.canForward();
  });
  effect(() => {
    const st = folder();
    const n = records.byId().size;
    if (!st || st.state !== "open") right.set("");
    else if (st.store?.phase === "checking") right.set("Checking…");
    else right.set(count(n, "record"));
  });

  // Sidebar: one tree, sections as foldable top-level items.
  effect(() => {
    const q = filterText().trim().toLowerCase();
    const f = folded();
    const open = libraryOpen();
    const match = (n: TreeNode): TreeNode | null => {
      if (n.children) {
        const kids = n.children.map(match).filter((x): x is TreeNode => !!x);
        return kids.length || n.label.toLowerCase().includes(q) ? { ...n, children: kids, expanded: q ? true : !f.includes(n.id) } : null;
      }
      return !q || n.label.toLowerCase().includes(q) ? n : null;
    };
    const nodes: TreeNode[] = open
      ? sidebar.values().map((s) => {
          const items = s.nodes().map(match).filter((x): x is TreeNode => !!x);
          return { id: `section:${s.id}`, label: s.title, expanded: q ? true : !f.includes(`section:${s.id}`), children: items.length ? items : [{ id: `empty:${s.id}`, label: q ? "Nothing matches" : s.emptyText, placeholder: true }] };
        })
      : [];
    tree.render(nodes);
  });

  // Pages: render the current route.
  effect(() => {
    const r = router.current();
    if (destroyed) return;
    const st = folder();
    let page = r.page;
    if (st && st.state !== "open" && page !== "settings") page = "welcome";
    const p = pages.get(page);
    if (!p) return;
    if (typeof dispose === "function") dispose();
    pageHost.replaceChildren();
    headerActions.replaceChildren();
    titleEl.textContent = p.title;
    document.title = p.title === "Welcome" ? "Librarium" : `${p.title} — Librarium`;
    for (const b of ribbonPageButtons) {
      const cur = b.dataset.page === page;
      b.classList.toggle("current", cur);
      if (cur) b.setAttribute("aria-current", "page");
      else b.removeAttribute("aria-current");
    }
    if (page !== lastPage) pageScroll.scrollTop = 0;
    lastPage = page;
    // A page renders untracked: what it reads must not re-render it (it subscribes itself).
    dispose = untracked(() => p.render(pageHost, r.params, {
      shell,
      setTitle: (t) => {
        titleEl.textContent = t;
        document.title = `${t} — Librarium`;
      },
      setHeaderActions: (nodes) => headerActions.replaceChildren(...nodes),
    }));
  });

  // Side panel sections that apply to the current route.
  let panelDisposers: (() => void)[] = [];
  effect(() => {
    const r = router.current();
    if (!panelOpen()) return;
    for (const d of panelDisposers) d();
    panelDisposers = [];
    const sections = sidePanel.values().filter((s) => s.applies(r));
    panelEl.replaceChildren(
      ...(sections.length
        ? sections.map((s) => {
            const body = h("div", { class: "panel-body" });
            const d = untracked(() => s.render(body, r));
            if (typeof d === "function") panelDisposers.push(d);
            return h("section", { class: "panel-section", "aria-label": s.title }, h("h2", { class: "panel-title" }, s.title), body);
          })
        : [h("p", { class: "empty" }, "Nothing more to show here.")]),
    );
  });

  // The menu's enabled states follow navigation and the library's state.
  effect(() => {
    router.current();
    router.canBack();
    router.canForward();
    folder();
    undo.last();
    refreshMenu(actions);
  });

  // ---- keys ---------------------------------------------------------------------------
  function onKey(e: KeyboardEvent) {
      const key = fromEvent(e);
      if (!key) return;
      const a = actions.forKey(key);
      if (!a) return;
      const target = e.target as Element | null;
      if (target?.closest?.(".cm-editor") && !a.reserved) return;
      if (!actions.available(a)) return;
      e.preventDefault();
      e.stopPropagation();
      void a.run();
  }
  document.addEventListener("keydown", onKey, true);

  // ---- dialogs ------------------------------------------------------------------------
  function openPalette() {
    const t = performance.now();
    const list = actions.all().filter((a) => a.palette !== false && actions.available(a));
    comboboxDialog({
      label: "Command palette",
      placeholder: "Type a command",
      emptyText: "No command matches.",
      choices: list.map((a) => ({ id: a.id, label: a.title, hint: a.keys?.[0] ? display(a.keys[0]) : undefined, icon: a.icon })),
      onPick: (c) => actions.run(c.id),
    });
    shell.timings.paletteOpenMs = performance.now() - t;
  }

  function openQuick() {
    const list = records.list().filter((r) => openers.get(r.kind));
    list.sort((a, b) => a.title.localeCompare(b.title));
    comboboxDialog({
      label: "Open a note or library item",
      placeholder: "Type a title",
      emptyText: "Nothing has that title.",
      choices: list.map((r) => ({ id: r.id, label: r.title || "Untitled", detail: r.kind === "note" ? r.path.split("/").slice(1, -1).join("/") : r.kind })),
      onPick: (c) => shell.openRecord(c.id),
    });
  }

  function openShortcuts() {
    const rows = actions.all().filter((a) => a.keys?.length);
    const m = modal(
      h("div", { class: "shortcuts" },
        h("h2", { class: "ask-title" }, "Keyboard shortcuts"),
        h("table", { class: "shortcut-table" },
          h("tbody", null, rows.map((a) => h("tr", null, h("td", null, a.title), h("td", null, h("kbd", null, display(a.keys![0]!)))))),
        ),
        h("div", { class: "ask-buttons" }, h("button", { class: "button primary", onclick: () => m.close() }, "Done")),
      ),
      { label: "Keyboard shortcuts" },
    );
    m.el.querySelector<HTMLButtonElement>("button")?.focus();
  }

  // ---- the library folder -------------------------------------------------------------
  async function chooseFolder(): Promise<void> {
    const path = await pickFolder("Choose the library folder");
    if (!path) return;
    const info = await call<FolderInfo>("folder.inspect", { path });
    const name = path.split("/").pop() || path;
    if (!info.is_library && !info.empty) {
      const choice = await ask(
        "Use a folder that already has files?",
        h("p", null, `“${name}” already holds files${info.markdown_files ? `, including ${count(Number(info.markdown_files), "Markdown file")}` : ""}. Librarium leaves them where they are and adds its own folders: notes, captures, items and .librarium. Markdown files inside notes become notes.`),
        [
          { label: "Choose another…", value: "other" },
          { label: "Use this folder", value: "use", primary: true },
        ],
      );
      if (choice === "other") return chooseFolder();
      if (choice !== "use") return;
    }
    const icloudNoted = prefs.pref("ui.icloudNoted", false);
    if (info.in_icloud && !icloudNoted.peek()) {
      await ask("This folder is in iCloud Drive", h("p", null, "Your notes will sync through iCloud. Librarium’s own data — its index, drafts and unfinished work — stays on this Mac, outside iCloud."), [{ label: "Continue", value: true, primary: true }]);
      icloudNoted.set(true);
    }
    try {
      const st = await call<LibraryStatus>("folder.open", { path });
      folder.set(st);
      await records.load();
      router.go(defaultPage());
    } catch (e) {
      report(e);
      await refreshFolder();
    }
  }

  function renderWelcome(host: HTMLElement) {
    const st = folder();
    if (st?.state === "missing") {
      replace(host,
        h("h1", { class: "page-title" }, "The library folder can’t be found"),
        h("p", null, `“${st.path}” isn’t there. It may be on a drive that isn’t connected right now.`),
        h("div", { class: "row" }, h("button", { class: "button primary", onclick: () => void chooseFolder() }, "Locate it…"), h("button", { class: "button", onclick: () => void chooseFolder() }, "Choose another folder…"), h("button", { class: "button", onclick: () => void refreshFolder(true) }, "Try again")),
      );
    } else if (st?.state === "opening") {
      replace(host, h("h1", { class: "page-title" }, "Opening your library"), h("p", { class: "muted" }, "Checking the folder for changes made while Librarium was closed…"));
    } else if (st?.state === "failed") {
      replace(host, h("h1", { class: "page-title" }, "The library couldn’t be opened"), h("p", null, st.error ?? ""), h("div", { class: "row" }, h("button", { class: "button primary", onclick: () => void chooseFolder() }, "Choose a folder…"), h("button", { class: "button", onclick: () => void refreshFolder(true) }, "Try again")));
    } else {
      replace(host,
        h("h1", { class: "page-title" }, "Welcome to Librarium"),
        h("p", null, "Everything you write and keep lives as plain files in a folder you choose, readable without this app."),
        h("div", { class: "row" }, h("button", { class: "button primary", onclick: () => void chooseFolder() }, "Choose a folder…")),
      );
    }
  }

  function renderSettings(host: HTMLElement) {
    const radios = (name: string, label: string, options: [string, string][], value: string, set: (v: string) => void) =>
      h("fieldset", { class: "field" }, h("legend", null, label), options.map(([v, l]) => h("label", { class: "radio" }, h("input", { type: "radio", name, value: v, checked: v === value, onchange: () => set(v) }), l)));
    const st = folder.peek();
    const sections: HTMLElement[] = [
      h("section", { class: "settings-section" }, h("h2", null, "Appearance"),
        radios("theme", "Theme", [["system", "Follow the system"], ["light", "Light"], ["dark", "Dark"]], String(theme.peek()), (v) => theme.set(v)),
        radios("text", "Text size", [["14", "Small"], ["16", "Medium"], ["18", "Large"]], String(textSize.peek()), (v) => textSize.set(Number(v))),
      ),
      h("section", { class: "settings-section" }, h("h2", null, "Library folder"),
        h("p", { class: "muted" }, st?.path ?? "Not chosen yet."),
        h("div", { class: "row" }, h("button", { class: "button", onclick: () => void chooseFolder() }, "Choose another folder…"), st?.state === "open" ? h("button", { class: "button", onclick: () => actions.run("shell.revealFolder") }, "Show in Finder") : null),
      ),
    ];
    const disposers: (() => void)[] = [];
    for (const s of settings.values()) {
      const body = h("div");
      const d = s.render(body);
      if (typeof d === "function") disposers.push(d);
      sections.push(h("section", { class: "settings-section" }, h("h2", null, s.title), body));
    }
    sections.push(h("section", { class: "settings-section" }, h("h2", null, "Troubleshooting"), h("div", { class: "row" }, h("button", { class: "button", onclick: () => actions.run("shell.revealLogs") }, "Reveal logs"))));
    replace(host, h("h1", { class: "page-title" }, "Settings"), ...sections);
    return () => disposers.forEach((d) => d());
  }

  function defaultPage(): string {
    return ribbonPages[0]?.id ?? "settings";
  }

  async function refreshFolder(retry = false): Promise<void> {
    try {
      let st = await call<LibraryStatus>("folder.status");
      if (retry && st.path && (st.state === "missing" || st.state === "failed")) {
        st = await call<LibraryStatus>("folder.open", { path: st.path }).catch(() => call<LibraryStatus>("folder.status"));
      }
      const wasOpen = folder.peek()?.state === "open";
      folder.set(st);
      if (st.state === "open" && !wasOpen) {
        await records.load();
        if (router.current.peek().page === "" || router.current.peek().page === "welcome") router.go(defaultPage(), {}, { replace: true });
      }
    } catch (e) {
      report(e);
    }
  }

  function report(e: unknown) {
    const msg = e && typeof e === "object" && "message" in e ? String((e as { message: unknown }).message) : String(e);
    toast(msg);
  }

  // ---- start --------------------------------------------------------------------------
  on("event.status", (p) => {
    const st = p as LibraryStatus;
    const wasOpen = folder.peek()?.state === "open";
    batch(() => folder.set(st));
    if (st.state === "open" && !wasOpen) void refreshFolder();
  });
  router.go("welcome");
  shell.timings.layoutMs = performance.now() - t0;
  void (async () => {
    await prefs.load();
    await refreshFolder();
    if (folder.peek()?.state === "open") router.go(defaultPage(), {}, { replace: true });
    shell.timings.readyMs = performance.now() - t0;
  })();
  return shell;
}
