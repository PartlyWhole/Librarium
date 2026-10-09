/**
 * Signals, computed values and effects. Effects re-run when a signal they read changes;
 * updates inside `batch` run effects once.
 */

type Effect = { run: () => void; deps: Set<Set<Effect>>; disposed: boolean };

let current: Effect | null = null;
let batchDepth = 0;
const pending = new Set<Effect>();

export interface ReadSignal<T> {
  (): T;
  peek(): T;
}

export interface Signal<T> extends ReadSignal<T> {
  set(value: T): void;
  update(fn: (value: T) => T): void;
}

function flush() {
  while (pending.size > 0) {
    const list = [...pending];
    pending.clear();
    for (const e of list) if (!e.disposed) execute(e);
  }
}

function execute(e: Effect) {
  for (const d of e.deps) d.delete(e);
  e.deps.clear();
  const prev = current;
  current = e;
  try {
    e.run();
  } finally {
    current = prev;
  }
}

export function signal<T>(initial: T, equals: (a: T, b: T) => boolean = Object.is): Signal<T> {
  let value = initial;
  const subs = new Set<Effect>();
  const read = (() => {
    if (current) {
      subs.add(current);
      current.deps.add(subs);
    }
    return value;
  }) as Signal<T>;
  read.peek = () => value;
  read.set = (next: T) => {
    if (equals(value, next)) return;
    value = next;
    for (const e of [...subs]) pending.add(e);
    if (batchDepth === 0) flush();
  };
  read.update = (fn) => read.set(fn(value));
  return read;
}

/** Runs `fn` now and again whenever a signal it read changes. Returns a disposer. */
export function effect(fn: () => void): () => void {
  const e: Effect = { run: fn, deps: new Set(), disposed: false };
  execute(e);
  return () => {
    e.disposed = true;
    for (const d of e.deps) d.delete(e);
    e.deps.clear();
  };
}

export function computed<T>(fn: () => T): ReadSignal<T> {
  const s = signal<T>(undefined as T);
  effect(() => s.set(fn()));
  const read = (() => s()) as ReadSignal<T>;
  read.peek = () => s.peek();
  return read;
}

/** Groups updates so effects run once, after `fn`. */
export function batch<T>(fn: () => T): T {
  batchDepth++;
  try {
    return fn();
  } finally {
    batchDepth--;
    if (batchDepth === 0) flush();
  }
}

/** Reads signals without subscribing the running effect. */
export function untracked<T>(fn: () => T): T {
  const prev = current;
  current = null;
  try {
    return fn();
  } finally {
    current = prev;
  }
}
