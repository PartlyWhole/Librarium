/** Notes: pages, the sidebar section (folders, plus groups other modules contribute). */
import { h } from "../../kit/dom";
import { icon } from "../../kit/icon";
import { effect } from "../../kit/signal";
import type { TreeNode } from "../../kit/tree";
import { call, pickSavePath } from "../../backend";
import { parseLinks } from "../../editor/links";
import type { RecordText } from "../../generated/RecordText";
import { toast } from "../../kit/toast";
import { renderNote } from "./page";
import type { Draft } from "../../generated/Draft";
import type { Written } from "../../generated/Written";
import type { ShellApi } from "../../shell/api";
import { NOTE_GROUPS, type NoteGroup } from "../../shell/slots";
import type { RecordInfo } from "../../generated/RecordInfo";
import { Files, FileText, FilePlus } from "lucide";

const KIND = "note";

/** The note's subfolder inside notes/, from its path (the path is the truth). */
export function folderOf(r: RecordInfo): string {
  const parts = r.path.split("/");
  return parts.slice(1, -1).join("/");
}

export function notes(shell: ShellApi): void {
  const groups = shell.slot<NoteGroup>(NOTE_GROUPS);
  shell.openers.add("notes", KIND, "note");
  shell.looks.add("notes", KIND, { kind: KIND, icon: () => FileText, kindName: () => "Note" });

  // Notes live in their own folders, browsed as in Finder; daily notes are shown apart.
  const grouped = (n: RecordInfo) => groups.values().some((g) => g.claims(n));
  shell.folders.add({
    kind: KIND,
    page: "notes",
    title: "Notes",
    hide: grouped,
    groups: () => groups.values(),
    emptyText: "No notes yet.",
    headerActions: () => [h("button", { class: "icon-button", "aria-label": "New note", title: "New note (⌘N)", onclick: () => shell.actions.run("notes.new") }, icon(FilePlus))],
  });
  shell.pages.add("notes", "notes", {
    id: "notes",
    title: "Notes",
    icon: Files,
    ribbon: 1,
    render: (host, params, ctx) => shell.folders.render(KIND, host, params, ctx),
  });

  shell.pages.add("notes", "note", {
    id: "note",
    title: "Note",
    icon: FileText,
    render: (host, params, ctx) => renderNote(shell, host, params, ctx),
  });

  shell.actions.add("notes", {
    id: "notes.new",
    title: "New note",
    keys: ["Mod+N"],
    reserved: true,
    when: () => shell.folder()?.state === "open",
    menu: { name: "file", group: 0 },
    icon: FilePlus,
    run: async () => {
      const r = shell.router.current.peek();
      const cur = r.page === "note" ? shell.records.get(r.params.id ?? "") : undefined;
      // Beside the note being read, or in the notes folder being looked at.
      const here = shell.here.peek();
      const folder = cur ? folderOf(cur) : here?.kind === KIND ? here.folder || undefined : undefined;
      const w = await call<Written>("notes.create", { folder });
      shell.records.put(w.info, w.seq);
      shell.router.go("note", { id: w.info.id, focus: "title" });
    },
  });
  shell.actions.add("notes", {
    id: "notes.exportWithQuotations",
    title: "Export with quotations…",
    when: () => shell.router.current().page === "note",
    menu: { name: "file", group: 3 },
    run: async () => {
      const id = shell.router.current.peek().params.id ?? "";
      const t = await call<RecordText>("records.read", { id });
      const path = await pickSavePath(`${t.info.title || "note"}.md`, "Export with quotations");
      if (!path) return;
      await call("export.write", { path, text: expandEmbeds(shell, t.body) });
      shell.status.show("Exported, with each quotation written out.");
    },
  });

  // Text recovered from an earlier run is offered back once the library opens.
  let offered = false;
  effect(() => {
    if (shell.folder()?.state !== "open" || offered) return;
    offered = true;
    void call<Draft[]>("drafts.list").then((drafts) => {
      if (!drafts.length) return;
      toast(drafts.length === 1 ? "Text you hadn’t saved was recovered." : `Text you hadn’t saved was recovered in ${drafts.length} notes.`, { action: { label: "Show", run: () => shell.openRecord(drafts[0]!.id) } });
    }, () => {});
  });

  shell.sidebar.add("notes", "notes", {
    id: "notes",
    title: "Notes",
    emptyText: "No notes yet.",
    drop: shell.folders.dropOnTop(KIND),
    nodes() {
      const all = shell.records.list(KIND);
      const r = shell.router.current();
      const current = r.page === "note" ? r.params.id : undefined;
      const open = (id: string) => shell.openRecord(id);
      const grouped: TreeNode[] = groups.values().map((g) => {
        const mine = all.filter((n) => g.claims(n)).sort(g.compare);
        return { id: `group:${g.id}`, label: g.title, children: mine.length ? mine.map((n) => ({ id: n.id, label: g.label(n), icon: FileText, current: n.id === current, onActivate: () => open(n.id) })) : [{ id: `group-empty:${g.id}`, label: "None yet", placeholder: true }] };
      });
      // Then the notes' folders, and the notes in them.
      return [...grouped, ...shell.folders.tree(KIND)];
    },
  }, 0);
}

/** A copy of a note's text with each embed written out (for reading outside the app). */
export function expandEmbeds(shell: ShellApi, body: string): string {
  let out = "";
  let last = 0;
  for (const l of parseLinks(body)) {
    if (!l.embed || !l.id) continue;
    const r = shell.records.get(l.id);
    const renderer = r ? shell.embeds.get(r.kind) : undefined;
    out += body.slice(last, l.from) + (r && renderer ? renderer.markdown(r) : l.label);
    last = l.to;
  }
  return out + body.slice(last);
}
