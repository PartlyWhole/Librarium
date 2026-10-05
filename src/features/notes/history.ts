/**
 * Version history of a note (decision 0038): a side-panel section listing its past versions
 * by day; a version opens a comparison with the text now, from which it can be restored (the
 * text before is kept as a version, so a restore can be undone).
 */
import { call } from "../../backend";
import { h, replace } from "../../kit/dom";
import { modal } from "../../kit/dialog";
import { effect } from "../../kit/signal";
import { toast } from "../../kit/toast";
import type { ShellApi } from "../../shell/api";
import type { HistoryVersion } from "../../generated/HistoryVersion";
import type { DiffLine } from "../../generated/DiffLine";
import type { SaveResult } from "../../generated/SaveResult";
import { History } from "lucide";

const ORIGIN: Record<string, string> = {
  app: "Edited here",
  outside: "Changed outside Librarium",
  "before-restore": "Before a restore",
  restore: "Restored",
};

const time = (ms: number) => new Date(ms).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
function day(ms: number): string {
  const d = new Date(ms);
  const today = new Date();
  const y = new Date();
  y.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === y.toDateString()) return "Yesterday";
  return d.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long", year: d.getFullYear() === today.getFullYear() ? undefined : "numeric" });
}
const message = (e: unknown) => String((e as { message?: string })?.message ?? e);

/** The comparison: what the version had (removed since) and what is new, with Restore. */
export async function compare(shell: ShellApi, id: string, v: HistoryVersion): Promise<void> {
  let lines: DiffLine[];
  try {
    lines = await call<DiffLine[]>("history.diff", { id, hash: v.hash });
  } catch (e) {
    return toast(message(e));
  }
  const changed = lines.filter((l) => l.op !== "equal").length;
  // Long unchanged stretches fold away, keeping three lines of context.
  const rows: HTMLElement[] = [];
  for (let i = 0; i < lines.length; ) {
    if (lines[i]!.op === "equal") {
      let j = i;
      while (j < lines.length && lines[j]!.op === "equal") j++;
      const run = lines.slice(i, j);
      const head = i === 0 ? 0 : 3;
      const tail = j === lines.length ? 0 : 3;
      if (run.length > head + tail + 2) {
        for (const l of run.slice(0, head)) rows.push(h("div", { class: "diff-line equal" }, l.text || " "));
        rows.push(h("div", { class: "diff-skip" }, `… ${run.length - head - tail} unchanged lines …`));
        for (const l of run.slice(run.length - tail)) rows.push(h("div", { class: "diff-line equal" }, l.text || " "));
      } else for (const l of run) rows.push(h("div", { class: "diff-line equal" }, l.text || " "));
      i = j;
    } else {
      const l = lines[i++]!;
      rows.push(h("div", { class: `diff-line ${l.op}`, "aria-label": l.op === "delete" ? "only in that version" : "only now" }, h("span", { class: "diff-sign", "aria-hidden": "true" }, l.op === "delete" ? "−" : "+"), l.text || " "));
    }
  }
  const when = `${day(v.ms)}, ${time(v.ms)}`;
  const restore = h("button", { class: "button primary", type: "button", hidden: v.current }, "Restore this version");
  const copy = h("button", { class: "button", type: "button" }, "Copy its text");
  const close = h("button", { class: "button", type: "button" }, "Close");
  const m = modal(
    h("div", { class: "ask history-compare" },
      h("h2", { class: "ask-title" }, `The version of ${when}`),
      v.current
        ? h("p", { class: "muted small" }, "This is the text as it is now.")
        : h("p", { class: "muted small" }, `${changed} ${changed === 1 ? "line differs" : "lines differ"} from now. `, h("span", { class: "diff-key delete" }, "− only in that version"), "  ", h("span", { class: "diff-key insert" }, "+ only now")),
      h("div", { class: "diff", tabindex: "0", role: "region", "aria-label": "Changes" }, rows),
      h("div", { class: "ask-buttons" }, close, copy, restore),
    ),
    { label: `The version of ${when}`, className: "wide" },
  );
  close.onclick = () => m.close();
  copy.onclick = () => void call<string>("history.read", { id, hash: v.hash }).then((t) => navigator.clipboard.writeText(t.replace(/^---\n[\s\S]*?\n---\n/, ""))).then(() => toast("Copied."), (e) => toast(message(e)));
  restore.onclick = async () => {
    const before = shell.records.get(id)?.version;
    if (!before) return;
    try {
      const r = await call<SaveResult>("history.restore", { id, hash: v.hash, base_version: before });
      m.close();
      if ("seq" in r) await shell.records.waitFor(r.seq);
      shell.undo.done(`Restored the version of ${when}.`, {
        label: "restoring",
        // The text before was kept as a version: its hash is the version it had.
        undo: async () => {
          const now = shell.records.get(id)?.version;
          if (now) await call("history.restore", { id, hash: before, base_version: now });
        },
        redo: async () => {
          const now = shell.records.get(id)?.version;
          if (now) await call("history.restore", { id, hash: v.hash, base_version: now });
        },
      });
    } catch (e) {
      toast(message(e));
    }
  };
  (v.current ? close : restore).focus();
}

/** The History section of the side panel, for the note shown. */
export function historySection(shell: ShellApi) {
  return {
    id: "history",
    title: "History",
    icon: History,
    applies: (r: { page: string }) => r.page === "note",
    render(host: HTMLElement, route: { params: Record<string, string> }) {
      const id = route.params.id ?? "";
      let last = "";
      const stop = effect(() => {
        // Again whenever the note changes.
        const version = shell.records.get(id)?.version ?? "";
        if (version === last) return;
        last = version;
        void call<HistoryVersion[]>("history.versions", { id }).then((vs) => {
          if (!vs.length) return replace(host, h("p", { class: "muted small" }, "Versions of this note show here as you write (at most one every five minutes), and when it changes outside Librarium."));
          const days = new Map<string, HistoryVersion[]>();
          for (const v of vs) days.set(day(v.ms), [...(days.get(day(v.ms)) ?? []), v]);
          replace(host, [...days].map(([d, list]) => [
            h("h3", { class: "history-day" }, d),
            h("ul", { class: "history-list" }, list.map((v) => h("li", null, h("button", { class: "history-item", type: "button", onclick: () => void compare(shell, id, v) },
              h("span", { class: "history-time" }, time(v.ms)),
              h("span", { class: "muted small" }, v.current ? "Current" : ORIGIN[v.origin] ?? v.origin),
            )))),
          ]));
        }, (e) => replace(host, h("p", { class: "muted small" }, message(e))));
      });
      return stop;
    },
  };
}
