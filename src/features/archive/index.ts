/**
 * Archive: the first of deletion's two steps (BRIEF §6). Archiving sets `archive.at` and leaves
 * the file in place; archived records drop out of lists and search (shell.hiding-fields) and
 * gather on the Archive page, where they can be restored or, after an explicit confirmation,
 * deleted permanently. Archive and restore can be undone; permanent deletion can't.
 */
import { h, replace } from "../../kit/dom";
import { icon } from "../../kit/icon";
import { Selection } from "../../kit/selection";
import { selectList, type SelectListElement } from "../../kit/selectlist";
import { selectBar } from "../../shell/selectbar";
import { ask } from "../../kit/dialog";
import { toast } from "../../kit/toast";
import { effect, signal, untracked } from "../../kit/signal";
import { count } from "../../kit/format";
import { call } from "../../backend";
import type { DeletedNote } from "../../generated/DeletedNote";
import type { ShellApi } from "../../shell/api";
import type { RecordInfo } from "../../generated/RecordInfo";
import type { Written } from "../../generated/Written";
import { Archive, ArchiveRestore, Trash2 } from "lucide";

const AT = "archive.at";

interface Preview {
  token: string;
  records: { id: string; title: string; kind: string; files: string[] }[];
  files: number;
}

interface Deleted {
  deleted: string[];
  skipped: { id: string; reason: string }[];
}

function message(e: unknown): string {
  return e && typeof e === "object" && "message" in e ? String((e as { message: unknown }).message) : String(e);
}

const isArchived = (r: RecordInfo | undefined) => r?.fields[AT] != null;

export function archive(shell: ShellApi): void {
  shell.hidingFields.add("archive", AT, AT);

  /**
   * Archives (or restores) records, offering one Undo for all of them; each undo expects the
   * version the change produced, and refuses for a record that changed since.
   */
  async function setArchived(ids: string[], archive: boolean): Promise<void> {
    const [doIt, undoIt] = archive ? ["archive.archive", "archive.restore"] : ["archive.restore", "archive.archive"];
    const done: Written[] = [];
    for (const id of ids) {
      try {
        const w = await call<Written>(doIt, { id });
        shell.records.put(w.info, w.seq);
        done.push(w);
      } catch (e) {
        toast(message(e));
      }
    }
    if (!done.length) return;
    const what = done.length === 1 ? `“${done[0]!.info.title || "Untitled"}”` : count(done.length, "item");
    const verb = archive ? "Archived" : "Restored";
    // Each step expects the versions the one before produced.
    const versions = new Map(done.map((w) => [w.info.id, w.info.version]));
    const each = async (method: string) => {
      for (const [id, version] of versions) {
        const x = await call<Written>(method, { id, base_version: version });
        versions.set(id, x.info.version);
        shell.records.put(x.info, x.seq);
      }
    };
    shell.undo.done(`${verb} ${what}`, {
      label: `${archive ? "archive" : "restore"} ${what}`,
      undo: () => each(undoIt),
      redo: () => each(doIt),
    });
  }
  const archiveRecord = (id: string) => setArchived([id], true);
  const restoreRecord = (id: string) => setArchived([id], false);

  /**
   * The second step. The backend lists exactly what would go and hands back a single-use token;
   * only the user's explicit "Delete permanently" sends it back. Cancel is the default button.
   */
  async function deletePermanently(ids: string[]): Promise<void> {
    let p: Preview;
    try {
      p = await call<Preview>("archive.prepareDelete", { ids });
    } catch (e) {
      toast(message(e));
      return;
    }
    const n = p.records.length;
    const title = n === 1 ? `Delete “${p.records[0]!.title || "Untitled"}” permanently?` : `Delete ${n} records permanently?`;
    const body = h(
      "div",
      null,
      h("p", null, `This removes ${count(p.files, "file")} from the library folder. It can’t be undone.`),
      n > 1 ? h("ul", { class: "delete-list" }, p.records.map((r) => h("li", null, r.title || "Untitled"))) : null,
    );
    const ok = await ask(title, body, [
      { label: "Cancel", value: false },
      { label: "Delete permanently", value: true, destructive: true },
    ]);
    if (!ok) return;
    try {
      const r = await call<Deleted>("archive.delete", { token: p.token });
      if (r.deleted.length) shell.status.show(r.deleted.length === 1 ? "Deleted permanently." : `Deleted ${count(r.deleted.length, "record")} permanently.`);
      for (const s of r.skipped) toast(`Not deleted: ${shell.records.get(s.id)?.title || "a record"} (${s.reason}).`);
    } catch (e) {
      toast(message(e));
    }
  }

  // Right-click (or the menu key) on a record, anywhere it is listed.
  const ids = (rs: RecordInfo[]) => rs.map((r) => r.id);
  const many = (one: string, several: (n: number) => string) => (n: number) => (n === 1 ? one : several(n));
  shell.recordActions.add("archive", "archive", { label: many("Archive", (n) => `Archive ${n} items`), applies: (r) => !isArchived(r) && !r.read_only, run: (rs) => setArchived(ids(rs), true) });
  shell.recordActions.add("archive", "restore", { label: many("Restore from archive", (n) => `Restore ${n} items`), applies: (r) => isArchived(r), run: (rs) => setArchived(ids(rs), false) });
  shell.recordActions.add("archive", "delete", { label: many("Delete permanently…", (n) => `Delete ${n} items permanently…`), destructive: true, applies: (r) => isArchived(r), run: (rs) => deletePermanently(ids(rs)) });

  const currentId = () => shell.router.current().params.id ?? "";

  shell.actions.add("archive", {
    id: "archive.archive",
    title: "Archive",
    when: () => {
      const r = shell.records.get(currentId());
      return !!r && !isArchived(r) && !r.read_only;
    },
    menu: { name: "file", group: 4 },
    run: async () => {
      const id = shell.router.current.peek().params.id ?? "";
      await archiveRecord(id);
      shell.router.go("archive");
    },
  });
  shell.actions.add("archive", {
    id: "archive.restore",
    title: "Restore from archive",
    when: () => isArchived(shell.records.get(currentId())),
    menu: { name: "file", group: 4 },
    run: () => restoreRecord(shell.router.current.peek().params.id ?? ""),
  });

  shell.pages.add("archive", "archive", {
    id: "archive",
    title: "Archive",
    icon: Archive,
    ribbon: 4,
    render(host) {
      const selection = new Selection();
      const mode = signal(false);
      let list: SelectListElement | null = null;
      const archived = () => [...shell.records.byId().values()].filter(isArchived).sort((a, b) => String(b.fields[AT]).localeCompare(String(a.fields[AT])));
      const bar = selectBar(shell, { selection, mode, items: archived, sync: () => list?.sync(), noun: ["record", "records"] });
      const stop = effect(() => {
        const all = archived();
        untracked(() => {
          if (!all.length) {
            list = null;
            replace(host, h("h1", { class: "page-title" }, "Archive"), h("p", { class: "empty" }, "Nothing is archived. Archived notes and items wait here until you restore them or delete them permanently."));
            return;
          }
          const when = (r: RecordInfo) => new Date(String(r.fields[AT])).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
          list = selectList({
            label: "Archived records",
            className: "item-list archive-list",
            items: all,
            selection,
            mode,
            id: (r) => r.id,
            render: (r) =>
              h("div", { class: "archive-row" },
                h("span", { class: "item-link" }, h("span", null, r.title || "Untitled"), h("span", { class: "muted small" }, `${r.kind} · archived ${when(r)}`)),
                h("button", { class: "button", type: "button", tabindex: "-1", onclick: () => void restoreRecord(r.id) }, icon(ArchiveRestore, 14), "Restore"),
                h("button", { class: "button destructive", type: "button", tabindex: "-1", onclick: () => void deletePermanently([r.id]) }, icon(Trash2, 14), "Delete permanently…"),
              ),
            open: (r) => shell.openRecord(r.id),
            menu: (rs, at) => shell.showRecordMenu(rs, at),
          });
          replace(
            host,
            h("h1", { class: "page-title" }, "Archive"),
            h("p", { class: "muted" }, `${count(all.length, "record")}, hidden from lists and search. Deleting here is permanent. To act on several, choose Select (or press ⌘A).`),
            bar.el,
            list,
          );
        });
      });
      // Notes deleted outside the app (Finder, sync): their history can bring them back.
      const deleted = h("section", { class: "recently-deleted" });
      const loadDeleted = () =>
        void call<DeletedNote[]>("history.deleted").then((list) => {
          replace(deleted, list.length ? [
            h("h2", { class: "list-heading" }, "Deleted outside Librarium"),
            h("p", { class: "muted small" }, "These notes were deleted in Finder or by sync. Their last version is kept in the library's history."),
            h("ul", { class: "plain-list" }, list.map((d) => h("li", { class: "archive-row" },
              h("span", { class: "item-link" }, h("span", null, d.title || "Untitled"), h("span", { class: "muted small" }, `last seen ${new Date(Number(d.ms)).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })}`)),
              h("button", { class: "button", type: "button", onclick: () => void call<Written>("history.bringBack", { id: d.id }).then((w) => (shell.records.put(w.info, w.seq), toast(`Brought back “${w.info.title || "Untitled"}”.`), loadDeleted()), (e: { message?: string }) => toast(e?.message ?? String(e))) }, icon(ArchiveRestore, 14), "Bring back"),
            ))),
          ] : []);
        }, () => {});
      loadDeleted();
      const keep = effect(() => {
        shell.records.byId();
        if (!host.contains(deleted)) host.appendChild(deleted);
      });
      return () => {
        stop();
        keep();
        bar.dispose();
      };
    },
  });
}
