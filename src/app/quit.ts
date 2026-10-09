/**
 * Quitting: ⌘Q, ⇧⌘W and the window's close button all come here (the backend sends
 * `app.quitting` for the ones it sees first). Work is saved, then the backend closes the
 * library and exits.
 */
import { call, on } from "../backend";
import { flushPrefs } from "./prefs";

const hooks = new Set<() => Promise<void> | void>();

/** Work to finish before the app quits or restarts (a last save). Returns an unregister. */
export function beforeQuit(fn: () => Promise<void> | void): () => void {
  hooks.add(fn);
  return () => hooks.delete(fn);
}

/** Runs every hook, then saves the preferences. */
export async function saveAll(): Promise<void> {
  await Promise.allSettled([...hooks].map((f) => f()));
  await flushPrefs();
}

let quitting = false;
export async function quit(): Promise<void> {
  if (quitting) return;
  quitting = true;
  await saveAll();
  await call("app.quit").catch((e) => {
    quitting = false;
    console.error("could not quit", e);
  });
}

on("app.quitting", () => void quit());
