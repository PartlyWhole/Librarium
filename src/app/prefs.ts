/** Per-device preferences, kept by the backend in settings.json (never in WebKit storage). */
import { call } from "../backend";
import { signal, type Signal } from "../ui/signal";

let values: Record<string, unknown> = {};
const signals = new Map<string, { s: Signal<unknown>; quiet: (v: unknown) => void }>();
let pending: Record<string, unknown> = {};
let timer: ReturnType<typeof setTimeout> | undefined;

/** Reads the saved preferences; signals already handed out take their saved values. */
export async function loadPrefs(): Promise<void> {
  values = await call<Record<string, unknown>>("settings.get").catch(() => ({}));
  for (const [k, { quiet }] of signals) if (k in values) quiet(values[k]);
}

/** A preference as a signal, with a default. Setting it saves (debounced). */
export function pref<T>(key: string, fallback: T): Signal<T> {
  const known = signals.get(key);
  if (known) return known.s as Signal<T>;
  const s = signal<T>((key in values ? values[key] : fallback) as T, (a, b) => JSON.stringify(a) === JSON.stringify(b));
  const quiet = s.set;
  s.set = (v: T) => {
    quiet(v);
    values[key] = v;
    pending[key] = v;
    clearTimeout(timer);
    timer = setTimeout(() => void flushPrefs(), 300);
  };
  s.update = (fn) => s.set(fn(s.peek()));
  signals.set(key, { s: s as Signal<unknown>, quiet: quiet as (v: unknown) => void });
  return s;
}

/** Saves what changed now (before quitting). */
export async function flushPrefs(): Promise<void> {
  clearTimeout(timer);
  const changed = pending;
  pending = {};
  if (!Object.keys(changed).length) return;
  await call("settings.set", { values: changed }).catch((e) => console.warn("could not save preferences", e));
}
