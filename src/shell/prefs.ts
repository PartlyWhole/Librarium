/**
 * Per-device preferences, saved by the backend in settings.json (never only in WebKit storage).
 */
import { call } from "../backend";
import { signal, type Signal } from "../kit/signal";

export class Prefs {
  private values: Record<string, unknown> = {};
  private signals = new Map<string, Signal<unknown>>();
  /** Each signal's own setter, which does not save. */
  private raw = new Map<string, (v: unknown) => void>();
  private pending: Record<string, unknown> = {};
  private timer: ReturnType<typeof setTimeout> | undefined;

  async load(): Promise<void> {
    try {
      this.values = await call<Record<string, unknown>>("settings.get");
    } catch {
      this.values = {};
    }
    for (const [k, set] of this.raw) if (k in this.values) set(this.values[k]);
  }

  /** A signal for a preference, with a default. Setting it saves (debounced). */
  pref<T>(key: string, fallback: T): Signal<T> {
    let s = this.signals.get(key) as Signal<T> | undefined;
    if (!s) {
      s = signal<T>((key in this.values ? this.values[key] : fallback) as T, (a, b) => JSON.stringify(a) === JSON.stringify(b));
      const set = s.set;
      this.raw.set(key, set as (v: unknown) => void);
      s.set = (v: T) => {
        set(v);
        this.values[key] = v;
        this.pending[key] = v;
        this.schedule();
      };
      s.update = (fn) => s!.set(fn(s!.peek()));
      this.signals.set(key, s as Signal<unknown>);
    }
    return s;
  }

  get(key: string): unknown {
    return this.values[key];
  }

  private schedule(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush(), 300);
  }

  async flush(): Promise<void> {
    const values = this.pending;
    this.pending = {};
    if (Object.keys(values).length === 0) return;
    try {
      await call("settings.set", { values });
    } catch (e) {
      console.warn("could not save preferences", e);
    }
  }
}
