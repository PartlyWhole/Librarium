/**
 * The Archive: the first of deletion's two steps. Archiving sets `archive.at` and leaves the
 * file in place; archived records drop out of lists and search and gather on the Archive page,
 * where they can be restored or, after an explicit confirmation, deleted permanently. Archiving
 * and restoring can be undone; permanent deletion can't.
 */
import { call } from "../backend";
import { defineAction } from "../app/actions";
import { pages } from "../app/pages";
import { ARCHIVED, getRecord, isArchived, openRecord, putRecord, records } from "../app/records";
import { recordActionsFor, addRecordAction, showRecordMenu } from "../app/recordmenu";
import { router } from "../app/router";
import { showStatus } from "../app/status";
import { done } from "../app/undo";
import { ask } from "../ui/dialog";
import { errorText, h, isEditable, replace } from "../ui/dom";
import { count, shortDate } from "../ui/format";
import { icon } from "../ui/icon";
import { selectList, Selection, type SelectListElement } from "../ui/selectlist";
import { effect, signal, untracked, type Signal } from "../ui/signal";
import { toast } from "../ui/toast";
import type { DeletedNote, RecordInfo, Written } from "../types";
import { Archive, ArchiveRestore, Trash2 } from "lucide";
import "./archive.css";

/** Archives or restores records, one at a time; each later step expects the version before. */
async function change(ids: string[], archive: boolean) {
  const [doIt, undoIt] = archive ? ["archive.archive", "archive.restore"] : ["archive.restore", "archive.archive"];
  const versions = new Map<string, string>();
  const changed: RecordInfo[] = [];
  for (const id of ids) {
    try {
      const w = await call<Written>(doIt, { id });
      putRecord(w.info);
      versions.set(id, w.info.version);
      changed.push(w.info);
    } catch (e) {
      toast(errorText(e));
    }
  }
  const each = async (method: string) => {
    for (const [id, version] of versions) {
      const w = await call<Written>(method, { id, base_version: version });
      versions.set(id, w.info.version);
      putRecord(w.info);
    }
  };
  return { changed, undo: () => each(undoIt), redo: () => each(doIt) };
}

/** Archives records for something larger (deleting a folder), which offers the Undo itself. */
export async function archiveRecords(ids: string[]): Promise<{ archived: number; undo(): Promise<void>; redo(): Promise<void> }> {
  const { changed, undo, redo } = await change(ids, true);
  return { archived: changed.length, undo, redo };
}

async function setArchived(ids: string[], archive: boolean): Promise<void> {
  const { changed, undo, redo } = await change(ids, archive);
  if (!changed.length) return;
  const what = changed.length === 1 ? `“${changed[0]!.title || "Untitled"}”` : count(changed.length, "item");
  done(`${archive ? "Archived" : "Restored"} ${what}`, { label: `${archive ? "archive" : "restore"} ${what}`, undo, redo });
}

/**
 * The second step. The backend lists exactly what would go and hands back a single-use token;
 * only an explicit "Delete permanently" sends it back. Cancel is the default.
 */
async function deletePermanently(ids: string[]): Promise<void> {
  type Preview = { token: string; records: { id: string; title: string }[]; files: number };
  let p: Preview;
  try {
    p = await call<Preview>("archive.prepareDelete", { ids });
  } catch (e) {
    return toast(errorText(e));
  }
  const n = p.records.length;
  const ok = await ask(n === 1 ? `Delete “${p.records[0]!.title || "Untitled"}” permanently?` : `Delete ${n} records permanently?`,
    h("div", null,
      h("p", null, `This removes ${count(p.files, "file")} from the library folder. It can’t be undone.`),
      n > 1 ? h("ul", { class: "delete-list" }, p.records.map((r) => h("li", null, r.title || "Untitled"))) : null),
    [{ label: "Cancel", value: false }, { label: "Delete permanently", value: true, destructive: true }]);
  if (!ok) return;
  try {
    const r = await call<{ deleted: string[]; skipped: { id: string; reason: string }[] }>("archive.delete", { token: p.token });
    if (r.deleted.length) showStatus(r.deleted.length === 1 ? "Deleted permanently." : `Deleted ${count(r.deleted.length, "record")} permanently.`);
    for (const s of r.skipped) toast(`Not deleted: ${getRecord(s.id)?.title || "a record"} (${s.reason}).`);
  } catch (e) {
    toast(errorText(e));
  }
}

const ids = (rs: RecordInfo[]) => rs.map((r) => r.id);
const many = (one: string, several: (n: number) => string) => (n: number) => (n === 1 ? one : several(n));
// Not captures: a capture is deleted by its own Delete, which asks about the notes using it.
addRecordAction({ id: "archive", label: many("Archive", (n) => `Archive ${n} items`), applies: (r) => !isArchived(r) && !r.read_only && r.kind !== "capture", run: (rs) => setArchived(ids(rs), true) });
addRecordAction({ id: "restore", label: many("Restore from archive", (n) => `Restore ${n} items`), applies: isArchived, run: (rs) => setArchived(ids(rs), false) });
addRecordAction({ id: "delete", label: many("Delete permanently…", (n) => `Delete ${n} items permanently…`), destructive: true, applies: isArchived, run: (rs) => deletePermanently(ids(rs)) });

const shown = () => getRecord(router.current().params.id);
defineAction({
  id: "archive.archive",
  title: "Archive",
  when: () => !!shown() && !isArchived(shown()) && !shown()!.read_only,
  menu: { name: "file", group: 4.1 },
  run: async () => {
    await setArchived([untracked(shown)!.id], true);
    router.go("archive");
  },
});
defineAction({ id: "archive.restore", title: "Restore from archive", when: () => isArchived(shown()), menu: { name: "file", group: 4.2 }, run: () => setArchived([untracked(shown)!.id], false) });

/**
 * Select mode for the list: "Select" turns it on; then a click ticks a record, and the bar says
 * how many are selected and offers what the context menu would. ⌘A selects everything; Escape
 * leaves select mode.
 */
function selectBar(selection: Selection, mode: Signal<boolean>, items: () => RecordInfo[], sync: () => void): { el: HTMLElement; dispose(): void } {
  const el = h("div", { class: "select-bar", role: "toolbar", "aria-label": "Selection" });
  const stop = effect(() => {
    const on = mode();
    const chosen = items().filter((r) => selection.ids().has(r.id));
    sync();
    if (!on) return replace(el, h("button", { class: "button", type: "button", disabled: !items().length, onclick: () => mode.set(true) }, "Select"));
    const n = chosen.length;
    replace(el,
      h("span", { class: "select-count", "aria-live": "polite" }, n ? `${count(n, "record")} selected` : "Click records to select them"),
      (n ? recordActionsFor(chosen) : []).map((a) => h("button", { class: `button${a.destructive ? " destructive" : ""}`, type: "button", onclick: a.run }, a.label)),
      h("span", { class: "spacer" }),
      n < items().length
        ? h("button", { class: "link-button", type: "button", onclick: () => selection.set(items().map((r) => r.id)) }, "Select all")
        : h("button", { class: "link-button", type: "button", onclick: () => selection.clear() }, "Select none"),
      h("button", { class: "button", type: "button", onclick: () => (selection.clear(), mode.set(false)) }, "Done"));
  });
  const onKey = (e: KeyboardEvent) => {
    // A dialog or menu handles its own keys; a page in a hidden tab hears none.
    if (document.querySelector("dialog[open], .context-menu") || !el.isConnected || el.closest("[hidden]") || isEditable(e.target)) return;
    if (e.metaKey && e.key.toLowerCase() === "a") {
      e.preventDefault();
      mode.set(true);
      selection.set(items().map((r) => r.id));
    } else if (e.key === "Escape" && mode.peek()) {
      selection.clear();
      mode.set(false);
    }
  };
  window.addEventListener("keydown", onKey);
  return { el, dispose: () => (stop(), window.removeEventListener("keydown", onKey)) };
}

/** Notes deleted outside the app (in Finder, by sync): their history can bring them back. */
function deletedOutside(): HTMLElement {
  const el = h("section", { class: "recently-deleted" });
  const bringBack = (d: DeletedNote) =>
    void call<Written>("history.bringBack", { id: d.id }).then((w) => {
      putRecord(w.info);
      toast(`Brought back “${w.info.title || "Untitled"}”.`);
      load();
    }, (e) => toast(errorText(e)));
  const load = () =>
    void call<DeletedNote[]>("history.deleted").then((list) => replace(el, list.length ? [
      h("h2", { class: "list-heading" }, "Deleted outside Librarium"),
      h("p", { class: "muted small" }, "These notes were deleted in Finder or by sync. Their last version is kept in the library’s history."),
      h("ul", { class: "plain-list" }, list.map((d) => h("li", { class: "archive-row" },
        h("span", { class: "item-link" }, h("span", null, d.title || "Untitled"), h("span", { class: "muted small" }, `last seen ${shortDate(Number(d.ms))}`)),
        h("button", { class: "button", type: "button", onclick: () => bringBack(d) }, icon(ArchiveRestore, 14), "Bring back")))),
    ] : null), () => {});
  load();
  return el;
}

pages.archive = {
  title: "Archive",
  icon: Archive,
  render(host) {
    const selection = new Selection();
    const mode = signal(false);
    let list: SelectListElement | null = null;
    const archived = () => [...records().values()].filter(isArchived).sort((a, b) => String(b.fields[ARCHIVED]).localeCompare(String(a.fields[ARCHIVED])));
    const bar = selectBar(selection, mode, archived, () => list?.sync());
    const content = h("div");
    const stop = effect(() => {
      const all = archived();
      untracked(() => {
        if (!all.length) {
          list = null;
          return replace(content, h("p", { class: "empty" }, "Nothing is archived. Archived notes and items wait here until you restore them or delete them permanently."));
        }
        list = selectList({
          label: "Archived records",
          className: "item-list",
          items: all,
          selection,
          mode,
          id: (r) => r.id,
          render: (r) => h("div", { class: "archive-row" },
            h("span", { class: "item-link" }, h("span", null, r.title || "Untitled"), h("span", { class: "muted small" }, `${r.kind} · archived ${shortDate(String(r.fields[ARCHIVED]))}`)),
            h("button", { class: "button", type: "button", tabindex: "-1", onclick: () => void setArchived([r.id], false) }, icon(ArchiveRestore, 14), "Restore"),
            h("button", { class: "button destructive", type: "button", tabindex: "-1", onclick: () => void deletePermanently([r.id]) }, icon(Trash2, 14), "Delete permanently…")),
          open: (r) => openRecord(r.id),
          menu: (rs, at) => showRecordMenu(rs, at),
        });
        replace(content, h("p", { class: "muted" }, `${count(all.length, "record")}, hidden from lists and search. Deleting here is permanent. To act on several, choose Select (or press ⌘A).`), bar.el, list);
      });
    });
    replace(host, h("h1", { class: "page-title" }, "Archive"), content, deletedOutside());
    return () => (stop(), bar.dispose());
  },
};
