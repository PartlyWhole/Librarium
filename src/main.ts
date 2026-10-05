/** The interface's composition root: the only module that names every feature. */
import { call } from "./backend";
import { createShell } from "./shell/shell";
import { keystrokes } from "./editor/editor";
import { notes } from "./features/notes";
import { daily } from "./features/daily";
import { library } from "./features/library";
import { search } from "./features/search";
import { archive } from "./features/archive";
import { links } from "./features/links";
import { captures } from "./features/captures";
import { undoHistory } from "./features/undo-history";

const shell = createShell(document.getElementById("app")!, [notes, daily, library, captures, search, links, archive, undoHistory]);
(window as unknown as { librarium: unknown }).librarium = { timings: shell.timings };

// Interface errors go to the app's log file (nothing is sent anywhere).
const log = (level: string, message: string) => void call("app.log", { level, message }).catch(() => {});
for (const level of ["warn", "error"] as const) {
  const original = console[level].bind(console);
  console[level] = (...args: unknown[]) => {
    original(...args);
    log(level, args.map((a) => (a instanceof Error ? a.stack ?? a.message : typeof a === "string" ? a : JSON.stringify(a))).join(" "));
  };
}
window.addEventListener("error", (e) => log("error", `${e.message} at ${e.filename}:${e.lineno}`));
window.addEventListener("unhandledrejection", (e) => log("error", `unhandled: ${String(e.reason?.stack ?? e.reason)}`));
setTimeout(() => log("info", `interface timings: ${JSON.stringify(shell.timings)}`), 3000);

// Keystroke-to-paint, logged every 100 keystrokes (budget: 16 ms).
let reported = 0;
setInterval(() => {
  if (keystrokes.length - reported < 100) return;
  reported = keystrokes.length;
  const s = [...keystrokes].sort((a, b) => a - b);
  const p = (q: number) => s[Math.min(s.length - 1, Math.floor(q * s.length))]!.toFixed(1);
  log("info", `keystroke to paint: median ${p(0.5)} ms, p95 ${p(0.95)} ms over ${s.length}`);
}, 5000);
(window as unknown as { librarium: Record<string, unknown> }).librarium.keystrokes = keystrokes;
