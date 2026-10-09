/**
 * A saved web page's snapshots in the reader: the notices from its page checks, the snapshot
 * picker and the Snapshots… dialog (removing goes through the library's two-step removal).
 */
import { router } from "../app/router";
import { removeSnapshots } from "../library/snapshots";
import { ask } from "../ui/dialog";
import { h } from "../ui/dom";
import { toast } from "../ui/toast";
import type { RecordInfo } from "../types";

export type Snapshot = { at: string; checks?: { kind: string; reason: string }[]; "final-url"?: string };

export const snapshotsOf = (r: RecordInfo): Snapshot[] => (Array.isArray(r.fields["library.snapshots"]) ? (r.fields["library.snapshots"] as Snapshot[]) : []);

/** "2026-10-02T091400Z" → a short local date and time. */
export function snapshotLabel(at: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(at);
  if (!m) return at;
  return new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!)).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/** The notices for the snapshot shown ("About this snapshot: …"). */
export function snapshotNotices(r: RecordInfo, showing: string): HTMLElement[] {
  const s = snapshotsOf(r).find((x) => x.at === showing);
  return (s?.checks ?? []).map((c) => h("p", { class: "notice" }, `About this snapshot: ${c.reason}`));
}

/** The picker and the Snapshots… button, when a page has more than one snapshot. */
export function snapshotControls(r: RecordInfo, showing: string): HTMLElement[] {
  const snaps = snapshotsOf(r);
  if (snaps.length < 2) return [];
  const pick = h("select", { class: "snapshot-pick", "aria-label": "Snapshot", onchange: () => router.go("item", { id: r.id, snapshot: pick.value }, { replace: true }) },
    snaps.map((s) => h("option", { value: s.at, selected: s.at === showing }, snapshotLabel(s.at))));
  return [pick, h("button", { class: "link-button small", type: "button", onclick: () => void manageSnapshots(r, showing) }, "Snapshots…")];
}

/** "Snapshots…": tick the snapshots of a page to remove. */
async function manageSnapshots(r: RecordInfo, showing: string): Promise<void> {
  const snaps = snapshotsOf(r);
  const latest = snaps[snaps.length - 1]?.at;
  const boxes = snaps.map((s) => h("input", { type: "checkbox", value: s.at, "aria-label": snapshotLabel(s.at) }));
  const rows = snaps.map((s, i) =>
    h("label", { class: "check-row snapshot-row" }, boxes[i]!, h("span", null, snapshotLabel(s.at)),
      h("span", { class: "muted small" }, [s.at === latest ? "latest" : "", s.at === showing ? "showing" : "", ...(s.checks ?? []).map((c) => c.kind)].filter(Boolean).join(" · "))));
  const go = await ask(`Snapshots of “${r.title || "Untitled"}”`,
    h("div", null, h("p", { class: "muted small" }, "Tick the snapshots to remove. A page keeps at least one, and snapshots that captures were made from stay."), h("div", { class: "snapshot-list" }, rows)),
    [{ label: "Cancel", value: false }, { label: "Remove ticked…", value: true, destructive: true }]);
  if (!go) return;
  const ticked = boxes.filter((b) => b.checked).map((b) => b.value);
  if (!ticked.length) return toast("Nothing was ticked.");
  // The snapshot shown may be gone: show what remains.
  if ((await removeSnapshots([{ id: r.id, snapshots: ticked }])) && ticked.includes(showing)) router.go("item", { id: r.id }, { replace: true });
}
