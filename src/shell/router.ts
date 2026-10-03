/** Navigation with history, so back and forward work. */
import { signal } from "../kit/signal";

export interface Route {
  page: string;
  params: Record<string, string>;
}

export function sameRoute(a: Route, b: Route): boolean {
  return a.page === b.page && JSON.stringify(a.params) === JSON.stringify(b.params);
}

export class Router {
  readonly current = signal<Route>({ page: "", params: {} });
  readonly canBack = signal(false);
  readonly canForward = signal(false);
  private stack: Route[] = [];
  private index = -1;

  go(page: string, params: Record<string, string> = {}, opts: { replace?: boolean } = {}): void {
    const r = { page, params };
    if (this.index >= 0 && sameRoute(this.stack[this.index]!, r)) return;
    if (opts.replace && this.index >= 0) this.stack[this.index] = r;
    else {
      this.stack = this.stack.slice(0, this.index + 1);
      this.stack.push(r);
      this.index = this.stack.length - 1;
    }
    this.sync();
  }

  back(): void {
    if (this.index > 0) {
      this.index--;
      this.sync();
    }
  }

  forward(): void {
    if (this.index < this.stack.length - 1) {
      this.index++;
      this.sync();
    }
  }

  /** Drops history entries matching a predicate (e.g. a record that no longer exists). */
  forget(pred: (r: Route) => boolean): void {
    const cur = this.stack[this.index];
    this.stack = this.stack.filter((r) => r === cur || !pred(r));
    this.index = cur ? this.stack.indexOf(cur) : -1;
    this.sync();
  }

  private sync(): void {
    this.current.set(this.stack[this.index]!);
    this.canBack.set(this.index > 0);
    this.canForward.set(this.index < this.stack.length - 1);
  }
}
