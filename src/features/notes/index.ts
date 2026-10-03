/** Notes: pages, and the Notes section (its folders and notes, daily notes among them). */
import { h } from "../../kit/dom";
import { icon } from "../../kit/icon";
import { effect } from "../../kit/signal";
import { call, pickSavePath } from "../../backend";
import { parseLinks } from "../../editor/links";
import type { RecordText } from "../../generated/RecordText";
import { toast } from "../../kit/toast";
import { renderNote } from "./page";
import { FORMATS } from "../../editor/format";
import { activeEditor } from "../../editor/editor";
import type { Draft } from "../../generated/Draft";
import type { Written } from "../../generated/Written";
import type { ShellApi } from "../../shell/api";
import type { RecordInfo } from "../../generated/RecordInfo";
import { Files, FileText, FilePlus } from "lucide";

const KIND = "note";

/** The note's subfolder inside notes/, from its path (the path is the truth). */
export function folderOf(r: RecordInfo): string {
  const parts = r.path.split("/");
  return parts.slice(1, -1).join("/");
}

export function notes(shell: ShellApi): void {
  shell.openers.add("notes", KIND, "note");
  shell.looks.add("notes", KIND, { kind: KIND, icon: () => FileText, kindName: () => "Note" });

  // Notes live in their own folders, browsed as in Finder (daily notes too: they are notes).
  shell.folders.add({
    kind: KIND,
    page: "notes",
    title: "Notes",
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
  // The Format menu: what the formatting keys do, for the editor last used.
  FORMATS.forEach((f, i) =>
    shell.actions.add("notes", {
      id: `format.${f.id}`,
      title: f.title,
      keys: [f.keys],
      when: () => (shell.router.current(), !!activeEditor()),
      menu: { name: "format", group: i < 5 ? 0 : i < 7 ? 1 : 2 },
      run: () => {
        const v = activeEditor();
        if (!v) return;
        f.run(v);
        v.focus();
      },
    }),
  );

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
    nodes: () => shell.folders.tree(KIND),
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
