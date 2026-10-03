/**
 * Jobs in the shell: running jobs in the status bar, and the Jobs view in the side panel
 * (running with Cancel, failed with Retry and Dismiss, and recent jobs).
 */
import { call, on } from "../backend";
import { h, replace } from "../kit/dom";
import { signal, effect } from "../kit/signal";
import { toast } from "../kit/toast";
import type { JobInfo } from "../generated/JobInfo";
import type { JobsList } from "../generated/JobsList";
import type { ShellApi } from "./slots";

export function jobsUi(shell: ShellApi): void {
  const jobs = signal<JobsList>({ running: [], failed: [], recent: [], resumed: null });
  const load = async () => {
    try {
      const l = await call<JobsList>("jobs.list");
      jobs.set(l);
      return l;
    } catch {
      return null;
    }
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  on("event.job", (p) => {
    const j = p as JobInfo;
    // Update in place at once; refresh the full list shortly after.
    jobs.update((l) => {
      const others = (xs: JobInfo[]) => xs.filter((x) => x.id !== j.id);
      const running = j.state === "queued" || j.state === "running" ? [j, ...others(l.running)] : others(l.running);
      const failed = j.state === "failed" ? [j, ...others(l.failed)] : others(l.failed);
      const recent = j.state === "done" || j.state === "cancelled" ? [j, ...others(l.recent)].slice(0, 10) : others(l.recent);
      return { ...l, running, failed, recent };
    });
    clearTimeout(timer);
    timer = setTimeout(() => void load(), 500);
  });

  // The "Resumed 3 saves" note, once per opening.
  let opened = false;
  effect(() => {
    const open = shell.folder()?.state === "open";
    if (open && !opened) {
      opened = true;
      void load().then((l) => l?.resumed && shell.status.show(l.resumed, 6000));
    } else if (!open) opened = false;
  });

  // Running jobs on the left of the status bar.
  const jobsText = signal("");
  effect(() => {
    const r = jobs().running.filter((j) => j.state === "running");
    const f = jobs().failed.length;
    const parts: string[] = [];
    if (r.length === 1) parts.push(`${r[0]!.title}${r[0]!.progress != null ? ` ${Math.round(r[0]!.progress * 100)}%` : "…"}`);
    else if (r.length > 1) parts.push(`${r.length} jobs running…`);
    if (f) parts.push(`${f} failed`);
    jobsText.set(parts.join(" · "));
  });
  effect(() => {
    const t = jobsText();
    const el = document.querySelector(".status-jobs");
    if (el) el.textContent = t;
  });

  const row = (j: JobInfo, buttons: [string, () => void][]) =>
    h("li", { class: "job" }, h("div", null, h("span", null, j.title), j.progress != null && j.state === "running" ? h("span", { class: "muted" }, ` ${Math.round(j.progress * 100)}%`) : null), j.error ? h("div", { class: "muted small" }, j.error) : j.message ? h("div", { class: "muted small" }, j.message) : null, h("div", { class: "row tight" }, buttons.map(([label, run]) => h("button", { class: "link-button", onclick: run }, label))));
  const act = (method: string, id: string) => void call(method, { id }).then(load, (e) => toast(String(e?.message ?? e)));

  shell.sidePanel.add("shell", "jobs", {
    id: "jobs",
    title: "Jobs",
    applies: () => shell.folder()?.state === "open",
    render(host) {
      void load();
      return effect(() => {
        const l = jobs();
        replace(
          host,
          l.running.length + l.failed.length + l.recent.length === 0 ? h("p", { class: "muted" }, "No jobs.") : null,
          l.running.length ? h("ul", { class: "jobs" }, l.running.map((j) => row(j, [["Cancel", () => act("jobs.cancel", j.id)]]))) : null,
          l.failed.length ? [h("h3", { class: "panel-subtitle" }, "Failed"), h("ul", { class: "jobs" }, l.failed.map((j) => row(j, [["Retry", () => act("jobs.retry", j.id)], ["Dismiss", () => act("jobs.dismiss", j.id)]])))] : null,
          l.recent.length ? [h("h3", { class: "panel-subtitle" }, "Recent"), h("ul", { class: "jobs" }, l.recent.map((j) => row(j, [])))] : null,
        );
      });
    },
  }, 100);

  shell.actions.add("shell", {
    id: "shell.rebuildIndex",
    title: "Rebuild index",
    when: () => shell.folder()?.state === "open",
    menu: { name: "file", group: 8 },
    run: async () => {
      try {
        await call("index.rebuild");
        shell.status.show("Rebuilding the index…");
      } catch (e) {
        toast(String((e as { message?: string }).message ?? e));
      }
    },
  });
  shell.settings.add("shell", "index", {
    id: "index",
    title: "Index",
    render(host) {
      replace(host, h("p", { class: "muted small" }, "The index is rebuilt from your files whenever it is missing. Rebuilding never changes your files."), h("div", { class: "row" }, h("button", { class: "button", onclick: () => shell.actions.run("shell.rebuildIndex") }, "Rebuild index")));
    },
  }, 50);
}
