/** Notes: pages, the sidebar section (folders, plus groups other modules contribute). */
import { h, replace } from "../../kit/dom";
import { effect } from "../../kit/signal";
import type { TreeNode } from "../../kit/tree";
import { count } from "../../kit/format";
import { call } from "../../backend";
import type { ShellApi } from "../../shell/api";
import { NOTE_GROUPS, type NoteGroup } from "../../shell/slots";
import type { RecordInfo } from "../../generated/RecordInfo";
import type { RecordText } from "../../generated/RecordText";
import { Files, FileText, Folder } from "lucide";

const KIND = "note";

/** The note's subfolder inside notes/, from its path (the path is the truth). */
export function folderOf(r: RecordInfo): string {
  const parts = r.path.split("/");
  return parts.slice(1, -1).join("/");
}

/** Builds a folder tree of notes. */
export function folderTree(notes: RecordInfo[], open: (id: string) => void, currentId?: string): TreeNode[] {
  interface Dir { dirs: Map<string, Dir>; notes: RecordInfo[] }
  const root: Dir = { dirs: new Map(), notes: [] };
  for (const n of notes) {
    let d = root;
    for (const part of folderOf(n).split("/").filter(Boolean)) {
      let next = d.dirs.get(part);
      if (!next) d.dirs.set(part, (next = { dirs: new Map(), notes: [] }));
      d = next;
    }
    d.notes.push(n);
  }
  const build = (d: Dir, prefix: string): TreeNode[] => [
    ...[...d.dirs.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([name, sub]) => ({ id: `folder:${prefix}${name}`, label: name, icon: Folder, children: build(sub, `${prefix}${name}/`), expanded: true })),
    ...d.notes.sort((a, b) => (a.title || "").localeCompare(b.title || "")).map((n) => ({ id: n.id, label: n.title || "Untitled", icon: FileText, current: n.id === currentId, onActivate: () => open(n.id) })),
  ];
  return build(root, "");
}

export function notes(shell: ShellApi): void {
  const groups = shell.slot<NoteGroup>(NOTE_GROUPS);
  shell.openers.add("notes", KIND, "note");

  shell.pages.add("notes", "notes", {
    id: "notes",
    title: "Notes",
    icon: Files,
    ribbon: 1,
    render(host) {
      return effect(() => {
        const all = shell.records.list(KIND);
        const ungrouped = all.filter((n) => !groups.values().some((g) => g.claims(n)));
        if (all.length === 0) {
          replace(host, h("h1", { class: "page-title" }, "Notes"), h("p", { class: "empty" }, "No notes yet."));
          return;
        }
        const byFolder = new Map<string, RecordInfo[]>();
        for (const n of ungrouped) {
          const f = folderOf(n);
          byFolder.set(f, [...(byFolder.get(f) ?? []), n]);
        }
        replace(
          host,
          h("h1", { class: "page-title" }, "Notes"),
          h("p", { class: "muted" }, count(all.length, "note")),
          [...byFolder.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([f, list]) =>
            h("section", { class: "list-section" },
              f ? h("h2", { class: "list-heading" }, f) : null,
              h("ul", { class: "plain-list" }, list.sort((a, b) => a.title.localeCompare(b.title)).map((n) => h("li", null, h("a", { href: "#", class: "list-link", onclick: (e: Event) => (e.preventDefault(), shell.openRecord(n.id)) }, n.title || "Untitled")))),
            ),
          ),
        );
      });
    },
  });

  // The note page: read-only until the editor arrives (milestone 3).
  shell.pages.add("notes", "note", {
    id: "note",
    title: "Note",
    icon: FileText,
    render(host, params, ctx) {
      let alive = true;
      void call<RecordText>("records.read", { id: params.id }).then(
        (t) => {
          if (!alive) return;
          ctx.setTitle(t.info.title || "Untitled");
          replace(host, h("h1", { class: "page-title" }, t.info.title || "Untitled"), h("pre", { class: "note-plain" }, t.body));
        },
        () => alive && replace(host, h("p", { class: "empty" }, "This note can’t be found any more.")),
      );
      return () => (alive = false);
    },
  });

  shell.sidebar.add("notes", "notes", {
    id: "notes",
    title: "Notes",
    emptyText: "No notes yet.",
    nodes() {
      const all = shell.records.list(KIND);
      const r = shell.router.current();
      const current = r.page === "note" ? r.params.id : undefined;
      const open = (id: string) => shell.openRecord(id);
      const grouped: TreeNode[] = groups.values().map((g) => {
        const mine = all.filter((n) => g.claims(n)).sort(g.compare);
        return { id: `group:${g.id}`, label: g.title, children: mine.length ? mine.map((n) => ({ id: n.id, label: g.label(n), icon: FileText, current: n.id === current, onActivate: () => open(n.id) })) : [{ id: `group-empty:${g.id}`, label: "None yet", placeholder: true }] };
      });
      const rest = all.filter((n) => !groups.values().some((g) => g.claims(n)));
      return [...grouped, ...folderTree(rest, open, current)];
    },
  }, 0);
}
