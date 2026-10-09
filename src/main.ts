/**
 * Start-up: the features load first (each adds its pages, actions and views as its module
 * loads), then the window is built and the library opened.
 */
import { call } from "./backend";
import "./archive";
import "./search";
import "./notes";
import "./boards";
import "./library";
import "./reader";
import "./captures";
import "./websave";
import "./updates";
import { startApp } from "./app/shell";

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

startApp(document.getElementById("app")!);
