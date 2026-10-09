/**
 * Removing a saved page's older snapshots, in two steps: the backend lists what would go (never
 * a page's last snapshot, never one a capture was made from) with a single-use token, and only
 * the user's explicit confirmation sends the token back. It can't be undone, so Cancel is the
 * first button and the confirmation is red.
 */
import { call } from "../backend";
import { getRecord } from "../app/records";
import { showStatus } from "../app/status";
import { ask } from "../ui/dialog";
import { errorText, h } from "../ui/dom";
import { count } from "../ui/format";
import { toast } from "../ui/toast";
import type { RemovalPreview, SnapshotRequest, SnapshotsRemoved } from "../types";

/** Asks, then removes; true when snapshots were removed. `snapshots: null` means all but the latest. */
export async function removeSnapshots(items: SnapshotRequest[]): Promise<boolean> {
  let p: RemovalPreview;
  try {
    p = await call<RemovalPreview>("library.removeSnapshots.prepare", { items });
  } catch (e) {
    toast(errorText(e));
    return false;
  }
  const pages = p.items.filter((i) => i.remove.length);
  const guarded = p.items.flatMap((i) => i.protected);
  const keptNote = guarded.length
    ? h("p", { class: "muted small" }, `${count(guarded.length, "snapshot")} ${guarded.length === 1 ? "is" : "are"} kept because captures were made from ${guarded.length === 1 ? "it" : "them"}: `,
        guarded.flatMap((g) => g.by).map((t) => `“${t || "Untitled"}”`).join(", "), ".")
    : null;
  if (!p.count) {
    await ask("Nothing to remove", h("div", null, h("p", null, "Each page keeps at least one snapshot."), keptNote), [{ label: "OK", value: true, primary: true }]);
    return false;
  }
  const title = pages.length === 1 ? `Remove ${count(p.count, "snapshot")} of “${pages[0]!.title || "Untitled"}”?` : `Remove ${count(p.count, "snapshot")} from ${count(pages.length, "page")}?`;
  const ok = await ask(title,
    h("div", null,
      h("p", null, "Their PDFs and text are deleted from the library folder. This can’t be undone. Each page keeps at least one snapshot."),
      h("ul", { class: "delete-list" }, pages.map((i) => h("li", null, `${i.title || "Untitled"}: ${count(i.remove.length, "snapshot")} (keeps ${i.kept})`))),
      keptNote),
    [{ label: "Cancel", value: false }, { label: p.count === 1 ? "Remove snapshot" : "Remove snapshots", value: true, destructive: true }]);
  if (!ok) return false;
  try {
    const r = await call<SnapshotsRemoved>("library.removeSnapshots", { token: p.token });
    showStatus(`Removed ${count(r.removed, "snapshot")}.`);
    for (const s of r.skipped) toast(`Not removed from “${getRecord(s.id)?.title || "a page"}”: ${s.reason}.`);
    return r.removed > 0;
  } catch (e) {
    toast(errorText(e));
    return false;
  }
}
