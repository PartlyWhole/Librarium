/**
 * Navigation in tabs, as in Obsidian: each tab has its own history, so Back and Forward work in
 * it. `current` is the active tab's route. Two tabs never show the same thing: going somewhere
 * already open in another tab switches to it.
 */
import { batch, signal } from "../ui/signal";

export interface Route {
  page: string;
  params: Record<string, string>;
}

export function sameRoute(a: Route, b: Route): boolean {
  return a.page === b.page && JSON.stringify(a.params) === JSON.stringify(b.params);
}

/** What a route shows: a record (whatever the place in it), or a page with its params. */
export function placeOf(r: Route): string {
  return r.params.id ? `${r.page}:${r.params.id}` : `${r.page}:${JSON.stringify(r.params)}`;
}

/** A tab as the tab bar shows it. */
export interface TabInfo {
  id: string;
  route: Route;
  title: string;
}

/** What is kept of the tabs between runs (`ui.tabs`). */
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
const NOWHERE: Route = { page: "", params: {} };
let nextTab = 1;
const newTab = (stack: Route[] = [], title = ""): Tab => ({ id: `tab-${nextTab++}`, stack, index: stack.length - 1, title });
const routeOf = (t: Tab): Route => t.stack[t.index] ?? NOWHERE;

export interface GoOptions {
  /** Replaces the current entry instead of adding one. */
  replace?: boolean;
  newTab?: boolean;
  /** With `newTab`: opens it without showing it. */
  background?: boolean;
  /** Asks for the route even if it is shown already (the page is told again). */
  again?: boolean;
}

class Router {
  readonly current = signal<Route>(NOWHERE);
  readonly canBack = signal(false);
  readonly canForward = signal(false);
  /** The tabs, in order, and the active one's ID. */
  readonly tabs = signal<TabInfo[]>([]);
  readonly active = signal("");
  private list: Tab[] = [newTab()];
  private at = 0;
  private closed: Tab[] = [];

  constructor() {
    this.publish();
  }

  private get tab(): Tab {
    return this.list[this.at]!;
  }

  go(page: string, params: Record<string, string> = {}, opts: GoOptions = {}): void {
    const r = { page, params };
    // Already shown in another tab: that tab comes forward, at the place asked for.
    const other = this.list.findIndex((t, i) => (opts.newTab || i !== this.at) && t.index >= 0 && placeOf(routeOf(t)) === placeOf(r));
    if (other >= 0 && !opts.replace) {
      const t = this.list[other]!;
      if (opts.again || !sameRoute(routeOf(t), r)) t.stack[t.index] = r;
      if (!opts.background) this.at = other;
      return this.sync();
    }
    if (opts.newTab) {
      this.list.splice(this.at + 1, 0, newTab([r]));
      if (!opts.background) this.at += 1;
      return this.sync();
    }
    const t = this.tab;
    if (t.index >= 0 && sameRoute(routeOf(t), r)) {
      if (!opts.again) return;
      t.stack[t.index] = r;
    } else if (opts.replace && t.index >= 0) t.stack[t.index] = r;
    else {
      t.stack = [...t.stack.slice(0, t.index + 1), r].slice(-MAX_HISTORY);
      t.index = t.stack.length - 1;
    }
    t.title = "";
    this.sync();
  }

  back(): void {
    this.step(-1);
  }

  forward(): void {
    this.step(1);
  }

  private step(d: number): void {
    const t = this.tab;
    if (t.index + d < 0 || t.index + d >= t.stack.length) return;
    t.index += d;
    t.title = "";
    this.sync();
  }

  /** Opens a new tab (at `route`, or the New tab page) after the active one. */
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
    this.at = (this.at + step + this.list.length) % this.list.length;
    this.sync();
  }

  /** Closes a tab (the active one by default). The last one leaves a New tab page. */
  close(id: string = this.tab.id): void {
    const i = this.list.findIndex((t) => t.id === id);
    if (i < 0) return;
    this.remember(this.list.splice(i, 1));
    if (!this.list.length) this.list.push(newTab([{ page: "newtab", params: {} }]));
    // As in a browser: closing the active tab shows the one after it (or before, at the end).
    if (i < this.at || (i === this.at && this.at >= this.list.length)) this.at = Math.max(0, this.at - 1);
    this.sync();
  }

  closeOthers(id: string = this.tab.id): void {
    const keep = this.list.find((t) => t.id === id);
    if (!keep) return;
    this.remember(this.list.filter((t) => t !== keep));
    this.list = [keep];
    this.at = 0;
    this.sync();
  }

  private remember(tabs: Tab[]): void {
    this.closed = [...this.closed, ...tabs].slice(-MAX_CLOSED);
  }

  get canReopen(): boolean {
    return this.closed.length > 0;
  }

  /** Brings back the tab closed last, with its history (or shows it, if it is open again). */
  reopen(): void {
    const t = this.closed.pop();
    if (!t) return;
    const open = this.list.findIndex((x) => x.index >= 0 && placeOf(routeOf(x)) === placeOf(routeOf(t)));
    if (open >= 0) this.at = open;
    else this.list.splice(++this.at, 0, t);
    this.sync();
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

  /** A page's own title for its tab (a note's title, say). */
  setTitle(title: string, id: string = this.tab.id): void {
    const t = this.list.find((x) => x.id === id);
    if (!t || t.title === title) return;
    t.title = title;
    this.publish();
  }

  /** Drops history entries matching a predicate (a record that no longer exists). */
  forget(pred: (r: Route) => boolean): void {
    for (const t of this.list) {
      const cur = t.stack[t.index];
      t.stack = t.stack.filter((r) => r === cur || !pred(r));
      t.index = cur ? t.stack.indexOf(cur) : -1;
    }
    this.sync();
  }

  save(): SavedTabs {
    return { tabs: this.list.filter((t) => t.index >= 0).map((t) => ({ stack: t.stack, index: t.index, title: t.title })), active: this.at };
  }

  /** Brings back saved tabs (replacing what is open); a place shown twice comes back once. */
  restore(s: SavedTabs | null): boolean {
    const valid = (s?.tabs ?? []).filter((t) => Array.isArray(t.stack) && t.index >= 0 && t.index < t.stack.length);
    if (!valid.length) return false;
    const chosen = valid[Math.max(0, Math.min(valid.length - 1, s?.active ?? 0))]!;
    const want = placeOf(chosen.stack[chosen.index]!);
    const seen = new Set<string>();
    this.list = [];
    let active = 0;
    for (const t of valid) {
      const tab = { ...newTab(t.stack, t.title ?? ""), index: t.index };
      const p = placeOf(routeOf(tab));
      if (seen.has(p)) continue;
      seen.add(p);
      if (p === want) active = this.list.length;
      this.list.push(tab);
    }
    this.at = active;
    this.sync();
    return true;
  }

  private publish(): void {
    this.tabs.set(this.list.map((t) => ({ id: t.id, route: routeOf(t), title: t.title })));
    this.active.set(this.tab.id);
  }

  private sync(): void {
    const t = this.tab;
    // All at once: whoever follows the route sees the tab it is in.
    batch(() => {
      this.current.set(routeOf(t));
      this.canBack.set(t.index > 0);
      this.canForward.set(t.index < t.stack.length - 1);
      this.publish();
    });
  }
}

export const router = new Router();
export type { Router };
