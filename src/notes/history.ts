/**
 * Version history of a note: the side panel's History view lists its past versions by day; a
 * version opens a comparison with the text now, from which it can be restored (undoably: the
 * text before is kept as a version) or copied.
 */
import { call } from "../backend";
import { addPanelView } from "../app/panel";
import { getRecord } from "../app/records";
import { done, recordScope } from "../app/undo";
import { modal } from "../ui/dialog";
import { errorText, h, replace } from "../ui/dom";
import { effect } from "../ui/signal";
import { toast } from "../ui/toast";
import type { DiffLine, HistoryVersion } from "../types";
import { flushNote } from "./page";
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
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === yesterday.toDateString()) return "Yesterday";
  return d.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long", year: d.getFullYear() === today.getFullYear() ? undefined : "numeric" });
}

/** The diff's rows; long unchanged stretches fold away, keeping three lines of context. */
function diffRows(lines: DiffLine[]): HTMLElement[] {
  const rows: HTMLElement[] = [];
  const same = (l: DiffLine) => rows.push(h("div", { class: "diff-line equal" }, l.text || " "));
  for (let i = 0; i < lines.length; ) {
    if (lines[i]!.op !== "equal") {
      const l = lines[i++]!;
      rows.push(h("div", { class: `diff-line ${l.op}`, "aria-label": l.op === "delete" ? "only in that version" : "only now" }, h("span", { class: "diff-sign", "aria-hidden": "true" }, l.op === "delete" ? "−" : "+"), l.text || " "));
      continue;
    }
    let j = i;
    while (j < lines.length && lines[j]!.op === "equal") j++;
    const run = lines.slice(i, j);
    const head = i === 0 ? 0 : 3;
    const tail = j === lines.length ? 0 : 3;
    if (run.length > head + tail + 2) {
      run.slice(0, head).forEach(same);
      rows.push(h("div", { class: "diff-skip" }, `… ${run.length - head - tail} unchanged lines …`));
      run.slice(run.length - tail).forEach(same);
    } else run.forEach(same);
    i = j;
  }
  return rows;
}

/** Restores a version, as a step of the note's undo. */
async function restore(id: string, v: HistoryVersion, when: string): Promise<void> {
  await flushNote(id);
  const before = getRecord(id)?.version;
  if (!before) return;
  await call("history.restore", { id, hash: v.hash, base_version: before });
  // The text before was kept as a version: its hash is the version it had.
  const to = async (hash: string) => {
    const now = getRecord(id)?.version;
    if (now) await call("history.restore", { id, hash, base_version: now });
  };
  done(`Restored the version of ${when}.`, { label: "restoring", undo: () => to(before), redo: () => to(v.hash) }, recordScope(id));
}

/** The comparison of a version with the text now, with Restore and Copy. */
async function compare(id: string, v: HistoryVersion): Promise<void> {
  let lines: DiffLine[];
  try {
    lines = await call<DiffLine[]>("history.diff", { id, hash: v.hash });
  } catch (e) {
    return toast(errorText(e));
  }
  const changed = lines.filter((l) => l.op !== "equal").length;
  const when = `${day(v.ms)}, ${time(v.ms)}`;
  const restoreButton = h("button", { class: "button primary", type: "button", hidden: v.current }, "Restore this version");
  const copy = h("button", { class: "button", type: "button" }, "Copy its text");
  const close = h("button", { class: "button", type: "button" }, "Close");
  const m = modal(
    h("div", { class: "ask history-compare" },
      h("h2", { class: "ask-title" }, `The version of ${when}`),
      v.current
        ? h("p", { class: "muted small" }, "This is the text as it is now.")
        : h("p", { class: "muted small" }, `${changed} ${changed === 1 ? "line differs" : "lines differ"} from now. `, h("span", { class: "diff-key delete" }, "− only in that version"), "  ", h("span", { class: "diff-key insert" }, "+ only now")),
      h("div", { class: "diff", tabindex: "0", role: "region", "aria-label": "Changes" }, diffRows(lines)),
      h("div", { class: "ask-buttons" }, close, copy, restoreButton),
    ),
    { label: `The version of ${when}`, className: "wide" },
  );
  close.onclick = () => m.close();
  copy.onclick = () =>
    void call<string>("history.read", { id, hash: v.hash })
      .then((t) => navigator.clipboard.writeText(t.replace(/^---\n[\s\S]*?\n---\n/, "")))
      .then(() => toast("Copied."), (e) => toast(errorText(e)));
  restoreButton.onclick = () => void restore(id, v, when).then(() => m.close(), (e) => toast(errorText(e)));
  (v.current ? close : restoreButton).focus();
}

addPanelView({
  id: "history",
  title: "History",
  icon: History,
  applies: (r) => r.page === "note",
  render(host, route) {
    const id = route.params.id ?? "";
    let last: string | null = null;
    // Again whenever the note changes.
    return effect(() => {
      const version = getRecord(id)?.version ?? "";
      if (version === last) return;
      last = version;
      void call<HistoryVersion[]>("history.versions", { id }).then((vs) => {
        if (!vs.length) return replace(host, h("p", { class: "muted small" }, "Versions of this note show here as you write (at most one every five minutes), and when it changes outside Librarium."));
        const days = new Map<string, HistoryVersion[]>();
        for (const v of vs) days.set(day(v.ms), [...(days.get(day(v.ms)) ?? []), v]);
        replace(host, [...days].map(([d, list]) => [
          h("h3", { class: "history-day" }, d),
          h("ul", { class: "history-list" }, list.map((v) => h("li", null, h("button", { class: "history-item", type: "button", onclick: () => void compare(id, v) },
            h("span", { class: "history-time" }, time(v.ms)),
            h("span", { class: "muted small" }, v.current ? "Current" : ORIGIN[v.origin] ?? v.origin))))),
        ]));
      }, (e) => replace(host, h("p", { class: "muted small" }, errorText(e))));
    });
  },
});
