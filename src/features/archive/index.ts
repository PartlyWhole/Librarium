/**
 * Archive: the first of deletion's two steps (BRIEF §6). Archiving sets `archive.at` and leaves
 * the file in place; archived records drop out of lists and search (shell.hiding-fields) and
 * gather on the Archive page, where they can be restored or, after an explicit confirmation,
 * deleted permanently. Archive and restore can be undone; permanent deletion can't.
 */
import { h, replace } from "../../kit/dom";
import { icon } from "../../kit/icon";
import { ask } from "../../kit/dialog";
import { toast } from "../../kit/toast";
import { effect } from "../../kit/signal";
import { count } from "../../kit/format";
import { call } from "../../backend";
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

  /** Archives a record, offering Undo (which expects the version archiving produced). */
  async function archiveRecord(id: string): Promise<void> {
    try {
      const w = await call<Written>("archive.archive", { id });
      shell.records.put(w.info, w.seq);
      const title = w.info.title || "Untitled";
      shell.undo.done(`Archived “${title}”`, {
        label: `archive “${title}”`,
        undo: async () => {
          const back = await call<Written>("archive.restore", { id, base_version: w.info.version });
          shell.records.put(back.info, back.seq);
        },
      });
    } catch (e) {
      toast(message(e));
    }
  }

  async function restoreRecord(id: string): Promise<void> {
    try {
      const w = await call<Written>("archive.restore", { id });
      shell.records.put(w.info, w.seq);
      const title = w.info.title || "Untitled";
      shell.undo.done(`Restored “${title}”`, {
        label: `restore “${title}”`,
        undo: async () => {
          const back = await call<Written>("archive.archive", { id, base_version: w.info.version });
          shell.records.put(back.info, back.seq);
        },
      });
    } catch (e) {
      toast(message(e));
    }
  }

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
      return effect(() => {
        const list = [...shell.records.byId().values()].filter(isArchived).sort((a, b) => String(b.fields[AT]).localeCompare(String(a.fields[AT])));
        if (!list.length) {
          replace(host, h("h1", { class: "page-title" }, "Archive"), h("p", { class: "empty" }, "Nothing is archived. Archived notes and items wait here until you restore them or delete them permanently."));
          return;
        }
        replace(
          host,
          h("h1", { class: "page-title" }, "Archive"),
          h("p", { class: "muted" }, "Archived records are hidden from lists and search. Deleting here is permanent."),
          h(
            "ul",
            { class: "item-list archive-list", "aria-label": "Archived records" },
            list.map((r) =>
              h(
                "li",
                { class: "archive-row" },
                h("a", { href: "#", class: "item-link", onclick: (e: Event) => (e.preventDefault(), shell.openRecord(r.id)) }, h("span", null, r.title || "Untitled"), h("span", { class: "muted small" }, `${r.kind} · archived ${new Date(String(r.fields[AT])).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })}`)),
                h("button", { class: "button", type: "button", onclick: () => void restoreRecord(r.id) }, icon(ArchiveRestore, 14), "Restore"),
                h("button", { class: "button destructive", type: "button", onclick: () => void deletePermanently([r.id]) }, icon(Trash2, 14), "Delete permanently…"),
              ),
            ),
          ),
          list.length > 1 ? h("p", null, h("button", { class: "button destructive", type: "button", onclick: () => void deletePermanently(list.map((r) => r.id)) }, `Delete all ${list.length} permanently…`)) : null,
        );
      });
    },
  });
}
