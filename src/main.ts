/** The interface's composition root: the only module that names every feature. */
import { call } from "./backend";
import { createShell } from "./shell/shell";
import { notes } from "./features/notes";
import { daily } from "./features/daily";
import { library } from "./features/library";
import { search } from "./features/search";
import { archive } from "./features/archive";

const shell = createShell(document.getElementById("app")!, [notes, daily, library, search, archive]);
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
