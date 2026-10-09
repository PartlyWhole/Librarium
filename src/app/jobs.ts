/**
 * Background jobs in the interface: what runs, in the status bar (a button that opens the Jobs
 * view), and the Jobs view in the side panel: running and waiting with Cancel, failed with Retry
 * and Dismiss, and recent ones with repeats grouped.
 */
import { call, on } from "../backend";
import { errorText, h, replace } from "../ui/dom";
import { signal, effect } from "../ui/signal";
import { toast } from "../ui/toast";
import type { JobInfo, JobsList } from "../types";
import { isOpen } from "./library";
import { addPanelView, showPanelView } from "./panel";
import { getRecord } from "./records";
import { showStatus } from "./status";
import { ListChecks } from "lucide";

const jobs = signal<JobsList>({ running: [], failed: [], recent: [], resumed: null });

async function load(): Promise<JobsList | null> {
  try {
    const l = await call<JobsList>("jobs.list");
    jobs.set(l);
    return l;
  } catch {
    return null;
  }
}

let timer: ReturnType<typeof setTimeout> | undefined;
on("jobs.changed", () => {
  clearTimeout(timer);
  timer = setTimeout(() => void load(), 100);
});

// The "Resumed 3 saves" note, once each time the library opens.
let opened = false;
effect(() => {
  if (isOpen() && !opened) void load().then((l) => l?.resumed && showStatus(l.resumed, 6000));
  opened = isOpen();
});

/** The status bar's part: what runs, what waits, what failed. */
export function jobsStatus(): HTMLElement {
  const el = h("div", { class: "status-jobs", role: "status", "aria-live": "polite" });
  effect(() => {
    const l = jobs();
    const running = l.running.filter((j) => j.state === "running");
    const one = running.length === 1 ? running[0]! : null;
    const parts = [
      one ? `${one.title}${one.progress != null ? ` ${Math.round(one.progress * 100)}%` : "…"}` : running.length > 1 ? `${running.length} jobs running…` : "",
      l.running.length > running.length ? `${l.running.length - running.length} waiting` : "",
      l.failed.length ? `${l.failed.length} failed` : "",
    ].filter(Boolean);
    replace(el, parts.length ? h("button", { class: `status-link${l.failed.length ? " failed" : ""}`, type: "button", title: "Show jobs", onclick: () => showPanelView("jobs") }, parts.join(" · ")) : null);
  });
  return el;
}

/** What a job is about: a web page's address, or the record it works on. */
function subject(j: JobInfo): string | null {
  const url = (j.payload as { url?: unknown } | null)?.url;
  if (typeof url === "string") return url;
  const r = getRecord(j.key);
  return r ? r.title || "Untitled" : null;
}

function row(j: JobInfo, buttons: [string, () => void][]): HTMLElement {
  const about = subject(j);
  return h("li", { class: "job" },
    h("div", null, h("span", null, j.title), j.progress != null && j.state === "running" ? h("span", { class: "muted" }, ` ${Math.round(j.progress * 100)}%`) : null),
    about ? h("div", { class: "small job-subject", title: about }, about) : null,
    j.error ? h("div", { class: "muted small" }, `Why: ${j.error}`) : j.message ? h("div", { class: "muted small" }, j.message) : null,
    h("div", { class: "row tight" }, buttons.map(([label, run]) => h("button", { class: "link-button", onclick: run }, label))),
  );
}

/** Finished jobs, routine repeats grouped ("Refreshing link labels · 12 times, last at …"). */
function recentRows(list: JobInfo[]): HTMLElement[] {
  const groups = new Map<string, JobInfo[]>();
  for (const j of list) groups.set(j.title, [...(groups.get(j.title) ?? []), j]);
  return [...groups.values()].map((g) => {
    if (g.length === 1) return row(g[0]!, []);
    const last = new Date(Math.max(...g.map((j) => j.updated_ms))).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
    return h("li", { class: "job" }, h("div", null, g[0]!.title), h("div", { class: "muted small" }, `${g.length} times, last at ${last}`));
  });
}

async function each(method: string, list: JobInfo[]): Promise<void> {
  for (const j of list) await call(method, { id: j.id }).catch((e) => toast(errorText(e)));
  await load();
}

/** Whether any job runs or waits (reactive). */
export const anyJobs = () => jobs().running.length > 0;

/** Stops every job: waiting ones first, so none starts while the others are cancelled. */
export async function cancelAll(): Promise<void> {
  const list = jobs.peek().running;
  await each("jobs.cancel", [...list.filter((j) => j.state === "queued"), ...list.filter((j) => j.state !== "queued")]);
  showStatus(`Cancelled ${list.length} ${list.length === 1 ? "job" : "jobs"}.`);
}

function section(title: string, buttons: [string, () => void][], items: HTMLElement[]): HTMLElement[] {
  return [h("div", { class: "row tight jobs-head" }, h("h3", { class: "panel-subtitle" }, title), buttons.map(([label, run]) => h("button", { class: "link-button", onclick: run }, label))), h("ul", { class: "jobs" }, items)];
}

addPanelView({
  id: "jobs",
  title: "Jobs",
  icon: ListChecks,
  applies: () => isOpen(),
  render(host) {
    void load();
    return effect(() => {
      const { running, failed, recent } = jobs();
      const many = (n: number, b: [string, () => void][]) => (n > 1 ? b : []);
      replace(host,
        running.length + failed.length + recent.length ? null : h("p", { class: "muted" }, "No jobs."),
        running.length ? section(`Running and waiting (${running.length})`, many(running.length, [["Cancel all", () => void cancelAll()]]), running.map((j) => row(j, [["Cancel", () => void each("jobs.cancel", [j])]]))) : null,
        failed.length
          ? section(`Failed (${failed.length})`, many(failed.length, [["Retry all", () => void each("jobs.retry", failed)], ["Dismiss all", () => void each("jobs.dismiss", failed)]]), failed.map((j) => row(j, [["Retry", () => void each("jobs.retry", [j])], ["Dismiss", () => void each("jobs.dismiss", [j])]])))
          : null,
        recent.length ? [h("h3", { class: "panel-subtitle" }, "Recent"), h("ul", { class: "jobs" }, recentRows(recent))] : null,
      );
    });
  },
});

/** Rebuilds the index from the files (never changing them). */
export async function rebuildIndex(): Promise<void> {
  try {
    await call("index.rebuild");
    showStatus("Rebuilding the index…");
  } catch (e) {
    toast(errorText(e));
  }
}
