/** Daily: any note can be a day. Today's page, the daily group in Notes, the day's start. */
import { h, replace } from "../../kit/dom";
import { call } from "../../backend";
import type { Written } from "../../generated/Written";
import { longDate } from "../../kit/format";
import type { ShellApi } from "../../shell/api";
import { NOTE_GROUPS, type NoteGroup } from "../../shell/slots";
import type { RecordInfo } from "../../generated/RecordInfo";
import { CalendarDays } from "lucide";

export const DATE_FIELD = "daily.date";
export const DAY_START = "daily.dayStart";

export function dateOf(r: RecordInfo): string | null {
  const v = r.fields[DATE_FIELD];
  return typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
}

/** The local date a moment belongs to, when the day starts at `startHour`. */
export function localDate(now: Date, startHour: number): string {
  const d = new Date(now.getTime() - startHour * 3600_000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function daily(shell: ShellApi): void {
  const dayStart = shell.prefs.pref(DAY_START, 4);
  shell.slot<NoteGroup>(NOTE_GROUPS).add("daily", "daily", {
    id: "daily",
    title: "Daily notes",
    claims: (r) => r.kind === "note" && dateOf(r) !== null,
    compare: (a, b) => (dateOf(b) ?? "").localeCompare(dateOf(a) ?? "") || a.id.localeCompare(b.id),
    label: (r) => (r.title && r.title !== dateOf(r) ? r.title : longDate(dateOf(r)!)),
  });

  shell.pages.add("daily", "today", {
    id: "today",
    title: "Today",
    icon: CalendarDays,
    ribbon: 0,
    keys: "Mod+T",
    render(host) {
      // Today's note is one step away: open it, creating it if missing (one writer operation).
      let alive = true;
      const today = localDate(new Date(), dayStart.peek());
      replace(host, h("h1", { class: "page-title" }, longDate(today)), h("p", { class: "muted" }, "Opening today’s note…"));
      void call<Written>("daily.today").then(
        (w) => {
          shell.records.put(w.info, w.seq);
          if (alive && shell.router.current.peek().page === "today") shell.router.go("note", { id: w.info.id }, { replace: true });
        },
        (e) => alive && replace(host, h("p", { class: "empty" }, String(e?.message ?? e))),
      );
      return () => (alive = false);
    },
  });

  shell.settings.add("daily", "daily", {
    id: "daily",
    title: "Daily notes",
    render(host) {
      const select = h("select", { id: "day-start", onchange: () => dayStart.set(Number(select.value)) }, [0, 1, 2, 3, 4, 5, 6].map((hr) => h("option", { value: String(hr), selected: hr === dayStart.peek() }, hr === 0 ? "Midnight" : `${hr} a.m.`)));
      replace(host, h("div", { class: "field" }, h("label", { for: "day-start" }, "The day starts at "), select), h("p", { class: "muted small" }, "Writing after midnight but before this hour lands on the day before."));
    },
  });
}
