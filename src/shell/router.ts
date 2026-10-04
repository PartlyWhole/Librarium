/**
 * Navigation in tabs, as in Obsidian: each tab has its own history, so back and forward work
 * in it. `current` is the active tab's route; going somewhere changes the active tab unless a
 * new tab is asked for.
 */
import { batch, signal } from "../kit/signal";

export interface Route {
  page: string;
  params: Record<string, string>;
}

export function sameRoute(a: Route, b: Route): boolean {
  return a.page === b.page && JSON.stringify(a.params) === JSON.stringify(b.params);
}

/** What a route shows: a record (whatever its place in it), or a page with its params. Two
 * tabs never show the same thing (R-023). */
export function placeOf(r: Route): string {
  return r.params.id ? `${r.page}:${r.params.id}` : `${r.page}:${JSON.stringify(r.params)}`;
}

/** A tab as the tab bar shows it. */
export interface TabInfo {
  id: string;
  route: Route;
  title: string;
}

/** What is kept of the tabs between runs. */
export interface SavedTabs {
  tabs: { stack: Route[]; index: number; title: string }[];
  active: number;
}

interface Tab {
  id: string;
  stack: Route[];
  index: number;
  title: string;
}

const MAX_HISTORY = 100;
const MAX_CLOSED = 20;
let nextTab = 1;
const newId = () => `tab-${nextTab++}`;

export class Router {
  readonly current = signal<Route>({ page: "", params: {} });
  readonly canBack = signal(false);
  readonly canForward = signal(false);
  /** The tabs, in order, and which is active. */
  readonly tabs = signal<TabInfo[]>([]);
  readonly active = signal("");
  private list: Tab[] = [{ id: newId(), stack: [], index: -1, title: "" }];
  private at = 0;
  private closed: Tab[] = [];

  private get tab(): Tab {
    return this.list[this.at]!;
  }

  /** Goes to a page in the active tab (or a new one: `newTab`, `background` to stay here). */
  go(page: string, params: Record<string, string> = {}, opts: { replace?: boolean; newTab?: boolean; background?: boolean } = {}): void {
    const r = { page, params };
    // Already shown in another tab: that tab comes forward (at the place asked for).
    const other = this.list.findIndex((t, i) => (opts.newTab || i !== this.at) && t.index >= 0 && placeOf(t.stack[t.index]!) === placeOf(r));
    if (other >= 0 && !opts.replace) {
      const t = this.list[other]!;
      if (!sameRoute(t.stack[t.index]!, r)) t.stack[t.index] = r;
      if (!opts.background) this.at = other;
      this.sync();
      return;
    }
    if (opts.newTab) {
      const t: Tab = { id: newId(), stack: [r], index: 0, title: "" };
      this.list.splice(this.at + 1, 0, t);
      if (!opts.background) this.at += 1;
      this.sync();
      return;
    }
    const t = this.tab;
    if (t.index >= 0 && sameRoute(t.stack[t.index]!, r)) return;
    if (opts.replace && t.index >= 0) t.stack[t.index] = r;
    else {
      t.stack = t.stack.slice(0, t.index + 1);
      t.stack.push(r);
      if (t.stack.length > MAX_HISTORY) t.stack.shift();
      t.index = t.stack.length - 1;
    }
    t.title = "";
    this.sync();
  }

  back(): void {
    if (this.tab.index > 0) {
      this.tab.index--;
      this.tab.title = "";
      this.sync();
    }
  }

  forward(): void {
    if (this.tab.index < this.tab.stack.length - 1) {
      this.tab.index++;
      this.tab.title = "";
      this.sync();
    }
  }

  // ---- tabs -----------------------------------------------------------------------------

  /** Opens a new tab (at `route`, or the new-tab page) after the active one, and shows it. */
  newTab(route: Route = { page: "newtab", params: {} }): void {
    this.go(route.page, route.params, { newTab: true });
  }

  /** Shows a tab, by ID or by position (0-based; -1 is the last). */
  select(which: string | number): void {
    const i = typeof which === "number" ? (which < 0 ? this.list.length + which : which) : this.list.findIndex((t) => t.id === which);
    if (i < 0 || i >= this.list.length || i === this.at) return;
    this.at = i;
    this.sync();
  }

  /** The next (1) or previous (-1) tab, wrapping around. */
  cycle(step: 1 | -1): void {
    if (this.list.length < 2) return;
    this.at = (this.at + step + this.list.length) % this.list.length;
    this.sync();
  }

  /** Closes a tab (the active one by default). The last tab becomes a new tab instead. */
  close(id: string = this.tab.id): void {
    const i = this.list.findIndex((t) => t.id === id);
    if (i < 0) return;
    const [gone] = this.list.splice(i, 1);
    this.closed.push(gone!);
    if (this.closed.length > MAX_CLOSED) this.closed.shift();
    if (!this.list.length) this.list.push({ id: newId(), stack: [{ page: "newtab", params: {} }], index: 0, title: "" });
    // As in a browser: closing the active tab shows the one after it (or before, at the end).
    if (i < this.at || (i === this.at && this.at >= this.list.length)) this.at = Math.max(0, this.at - 1);
    this.sync();
  }

  /** Closes every tab but one. */
  closeOthers(id: string = this.tab.id): void {
    const keep = this.list.find((t) => t.id === id);
    if (!keep) return;
    for (const t of this.list) if (t !== keep) this.closed.push(t);
    this.closed.splice(0, Math.max(0, this.closed.length - MAX_CLOSED));
    this.list = [keep];
    this.at = 0;
    this.sync();
  }

  /** Brings back the tab closed last, with its history. */
  reopen(): boolean {
    const t = this.closed.pop();
    if (!t) return false;
    // Its page is open in another tab already: show that one.
    const cur = t.stack[t.index];
    const open = cur ? this.list.findIndex((x) => x.index >= 0 && placeOf(x.stack[x.index]!) === placeOf(cur)) : -1;
    if (open >= 0) {
      this.at = open;
      this.sync();
      return true;
    }
    this.list.splice(this.at + 1, 0, t);
    this.at += 1;
    this.sync();
    return true;
  }

  get canReopen(): boolean {
    return this.closed.length > 0;
  }

  /** Moves a tab to another position. */
  move(id: string, to: number): void {
    const i = this.list.findIndex((t) => t.id === id);
    if (i < 0) return;
    const active = this.tab;
    const [t] = this.list.splice(i, 1);
    this.list.splice(Math.max(0, Math.min(this.list.length, to)), 0, t!);
    this.at = this.list.indexOf(active);
    this.sync();
  }

  /** A page's own title for its tab (a note's title, say); the active tab's by default. */
  setTitle(title: string, id: string = this.tab.id): void {
    const t = this.list.find((x) => x.id === id);
    if (!t || t.title === title) return;
    t.title = title;
    this.publish();
  }

  /** Drops history entries matching a predicate (e.g. a record that no longer exists). */
  forget(pred: (r: Route) => boolean): void {
    for (const t of this.list) {
      const cur = t.stack[t.index];
      t.stack = t.stack.filter((r) => r === cur || !pred(r));
      t.index = cur ? t.stack.indexOf(cur) : -1;
    }
    this.sync();
  }

  /** The tabs to keep for next time. */
  save(): SavedTabs {
    return { tabs: this.list.filter((t) => t.index >= 0).map((t) => ({ stack: t.stack, index: t.index, title: t.title })), active: this.at };
  }

  /** Brings back saved tabs (replacing what is open). */
  restore(s: SavedTabs): boolean {
    const tabs = (s?.tabs ?? []).filter((t) => Array.isArray(t.stack) && t.stack.length && t.index >= 0 && t.index < t.stack.length);
    if (!tabs.length) return false;
    // Saved before tabs were kept apart: a page shown twice comes back once.
    const seen = new Set<string>();
    const activePlace = placeOf(tabs[Math.max(0, Math.min(tabs.length - 1, s.active ?? 0))]!.stack[tabs[Math.max(0, Math.min(tabs.length - 1, s.active ?? 0))]!.index]!);
    const kept = tabs.filter((t) => {
      const p = placeOf(t.stack[t.index]!);
      if (seen.has(p)) return false;
      seen.add(p);
      return true;
    });
    this.list = kept.map((t) => ({ id: newId(), stack: t.stack, index: t.index, title: t.title ?? "" }));
    this.at = Math.max(0, kept.findIndex((t) => placeOf(t.stack[t.index]!) === activePlace));
    this.sync();
    return true;
  }

  private publish(): void {
    this.tabs.set(this.list.map((t) => ({ id: t.id, route: t.stack[t.index] ?? { page: "", params: {} }, title: t.title })));
    this.active.set(this.tab.id);
  }

  private sync(): void {
    const t = this.tab;
    const r = t.stack[t.index] ?? { page: "", params: {} };
    // All at once: whoever follows the route sees the tab it is in.
    batch(() => {
      if (this.current.peek() !== r) this.current.set(r);
      this.canBack.set(t.index > 0);
      this.canForward.set(t.index < t.stack.length - 1);
      this.publish();
    });
  }
}
