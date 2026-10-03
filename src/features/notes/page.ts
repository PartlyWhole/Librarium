/** The note page: a title that renames, the editor, autosave, recovered drafts, conflicts. */
import { call, on } from "../../backend";
import { ask, modal } from "../../kit/dialog";
import { h, replace } from "../../kit/dom";
import { comboboxDialog } from "../../kit/combobox";
import { icon } from "../../kit/icon";
import { toast } from "../../kit/toast";
import { createEditor, replaceDoc } from "../../editor/editor";
import type { ShellApi } from "../../shell/api";
import type { PageContext } from "../../shell/slots";
import type { Change } from "../../generated/Change";
import type { Draft } from "../../generated/Draft";
import type { RecordText } from "../../generated/RecordText";
import type { Written } from "../../generated/Written";
import { NoteSession } from "../../editor/session";
import { FolderInput } from "lucide";

export function renderNote(shell: ShellApi, host: HTMLElement, params: Record<string, string>, ctx: PageContext): () => void {
  const id = params.id ?? "";
  let alive = true;
  let cleanup: (() => void)[] = [];
  const dispose = () => {
    alive = false;
    for (const c of cleanup) c();
    cleanup = [];
  };

  void (async () => {
    let t: RecordText;
    try {
      t = await call<RecordText>("records.read", { id });
    } catch {
      if (alive) replace(host, h("p", { class: "empty" }, "This note can’t be found any more."));
      return;
    }
    if (!alive) return;
    const draft = await call<Draft | null>("drafts.get", { id }).catch(() => null);
    if (!alive) return;
    let info = t.info;
    const readOnly = info.read_only;
    ctx.setTitle(info.title || "Untitled");

    // The recovered draft (newer than the file) is offered back.
    const recovered = draft && draft.body !== t.body ? draft : null;
    const startBody = recovered ? recovered.body : t.body;
    const notices = h("div", { class: "notices" });
    const titleInput = h("input", { class: "title-input", value: info.title, "aria-label": "Title", spellcheck: true, readOnly: !!readOnly, placeholder: "Untitled" });
    const editorHost = h("div", { class: "editor-host" });
    replace(host, titleInput, notices, editorHost);

    const status = (text: string, persistent = false) => shell.status.show(text, persistent ? 0 : 4000);
    const session = new NoteSession(id, recovered ? recovered.base_version : info.version, recovered ? recovered.base_body : t.body, {
      current: () => view.state.doc.toString(),
      merged: (body) => replaceDoc(view, body),
      conflict: (mine, theirs, version) => resolveConflict(shell, info.title, mine, theirs, version, id),
      status,
      saved: (seq) => void shell.records.waitFor(seq),
    });
    if (recovered) session.savedBody = t.body;

    const view = createEditor({
      parent: editorHost,
      doc: startBody,
      readOnly: !!readOnly,
      label: `${info.title || "Untitled"}, note text`,
      targets: () => shell.records.list().filter((r) => shell.openers.get(r.kind) && r.id !== id).map((r) => ({ id: r.id, title: r.title, detail: r.kind === "note" ? undefined : r.kind, embeddable: !!shell.embeds.get(r.kind) })),
      open: (target) => shell.openRecord(target),
      titleOf: (target) => shell.records.get(target)?.title ?? null,
      onChange: () => session.changed(),
      onBlur: () => void session.flush(),
      contributions: shell.editorExtensions.values(),
      placeholder: "Write…",
    });
    cleanup.push(() => {
      void session.close();
      view.destroy();
    });
    cleanup.push(shell.beforeClose(() => session.close()));

    if (readOnly) notices.appendChild(h("p", { class: "notice" }, `This note opens read-only. ${readOnly}`));
    if (info.conflicts.length) {
      notices.appendChild(h("p", { class: "notice" }, `Another copy of this note exists (${info.conflicts.join(", ")}), probably from a sync conflict. `, h("button", { class: "link-button", onclick: () => void compareCopies(info.conflicts, t.body) }, "Compare")));
    }
    if (recovered) {
      const bar = h("p", { class: "notice" }, "Text you hadn’t saved was recovered. ", h("button", { class: "link-button", onclick: () => void discard() }, "Discard it"));
      const discard = async () => {
        await call("drafts.discard", { id });
        replaceDoc(view, t.body);
        session.rebase(info.version, t.body);
        bar.remove();
      };
      notices.appendChild(bar);
      session.changed();
    }

    // Renaming: the slug follows the title; undo restores it if nothing changed since.
    const rename = async () => {
      const title = titleInput.value.replace(/\s+/g, " ").trim();
      if (!title || title === info.title) {
        titleInput.value = info.title;
        return;
      }
      const before = info.title;
      try {
        const w = await call<Written>("records.relocate", { id, title });
        info = w.info;
        shell.records.put(w.info, w.seq);
        session.rebase(w.info.version, session.savedBody);
        ctx.setTitle(title);
        shell.undo.done(`Renamed to “${title}”`, {
          label: `rename to “${title}”`,
          undo: async () => {
            const back = await call<Written>("records.relocate", { id, title: before, base_version: w.info.version });
            shell.records.put(back.info, back.seq);
            if (shell.router.current.peek().params.id === id) {
              info = back.info;
              titleInput.value = before;
              ctx.setTitle(before);
              session.rebase(back.info.version, session.savedBody);
            }
          },
        });
      } catch (e) {
        titleInput.value = info.title;
        toast(String((e as { message?: string }).message ?? e));
      }
    };
    titleInput.addEventListener("keydown", (e) => {
      if (e.isComposing) return;
      if (e.key === "Enter") {
        e.preventDefault();
        view.focus();
      } else if (e.key === "Escape") {
        titleInput.value = info.title;
        view.focus();
      }
    });
    titleInput.addEventListener("blur", () => void rename());

    ctx.setHeaderActions([
      h("button", { class: "icon-button", "aria-label": "Move to folder", title: "Move to folder", onclick: () => void moveNote(shell, id) }, icon(FolderInput)),
    ]);

    // Outside edits: reload when nothing is unsaved; otherwise the next save merges.
    cleanup.push(
      on("event.change", (p) => {
        const c = p as Change;
        if (c.id !== id || c.op === "removed") return;
        void call<RecordText>("records.read", { id }).then((fresh) => {
          // Our own saves are already shown; anything else (outside edits, repairs) reloads.
          if (!alive || fresh.info.version === session.baseVersion) return;
          info = fresh.info;
          if (!session.dirty) {
            replaceDoc(view, fresh.body);
            session.rebase(fresh.info.version, fresh.body);
          }
          titleInput.value = fresh.info.title;
          ctx.setTitle(fresh.info.title);
        });
      }),
    );

    if (params.at) {
      // A code-point offset (from search) → the editor's UTF-16 position.
      const cp = Number(params.at);
      let pos = 0;
      let n = 0;
      const doc = view.state.doc.toString();
      for (const ch of doc) {
        if (n++ >= cp) break;
        pos += ch.length;
      }
      view.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
      view.focus();
    } else if (params.focus === "title") {
      titleInput.focus();
      titleInput.select();
    } else if (!readOnly) view.focus();
  })();

  return dispose;
}

async function resolveConflict(shell: ShellApi, title: string, mine: string, theirs: string, version: string, id: string) {
  const pre = (label: string, text: string) => h("div", { class: "compare-col" }, h("h3", null, label), h("pre", { class: "compare-text" }, text));
  const choice = await ask(
    `“${title}” changed outside Librarium`,
    [h("p", null, "Those changes overlap yours, so they can’t be merged automatically. Nothing has been overwritten."), h("div", { class: "compare" }, pre("Yours", mine), pre("On disk", theirs))],
    [
      { label: "Keep both", value: "both" },
      { label: "Use the version on disk", value: "theirs" },
      { label: "Keep yours", value: "mine", primary: true },
    ],
  );
  if (choice === "mine") return { body: mine, version, baseBody: theirs };
  if (choice === "theirs") {
    await call("drafts.discard", { id });
    return { body: theirs, version, baseBody: theirs };
  }
  if (choice === "both") {
    const w = await call<Written>("notes.create", { title: `${title} (your version)`, body: mine });
    shell.records.put(w.info, w.seq);
    toast(`Your version was kept as “${w.info.title}”.`);
    return { body: theirs, version, baseBody: theirs };
  }
  return null;
}

async function compareCopies(paths: string[], body: string) {
  const m = modal(
    h("div", { class: "ask" }, h("h2", { class: "ask-title" }, "Two copies of this note"), h("p", null, `The other copy is at ${paths.join(", ")}. Open it in Finder to compare, or keep this one and remove the other yourself.`), h("pre", { class: "compare-text" }, body), h("div", { class: "ask-buttons" }, h("button", { class: "button primary", onclick: () => m.close() }, "Done"))),
    { label: "Two copies of this note" },
  );
}

/** Moves a note to a folder (new or existing), with undo. */
export async function moveNote(shell: ShellApi, id: string): Promise<void> {
  // Every folder (notes and library items share them), empty ones too.
  const folders = await call<{ folders: string[] }>("folders.list").then((l) => l.folders, () => [] as string[]);
  const r = shell.records.get(id);
  const from = r ? r.path.split("/").slice(1, -1).join("/") : "";
  const choices = [{ id: "", label: "Notes (top level)" }, ...folders.map((f) => ({ id: f, label: f }))];
  comboboxDialog({
    label: "Move to folder",
    placeholder: "Type a folder name (new or existing)",
    emptyText: "Press Return to create this folder.",
    choices,
    filter: (cs, q) => {
      const t = q.trim().replace(/^\/+|\/+$/g, "");
      const hits = cs.filter((c) => c.label.toLowerCase().includes(t.toLowerCase()));
      return t && !cs.some((c) => c.id === t) ? [{ id: t, label: `New folder “${t}”` }, ...hits] : hits;
    },
    onPick: async (c) => {
      if (c.id === from) return;
      try {
        const w = await call<Written>("records.relocate", { id, subfolder: c.id || null });
        shell.records.put(w.info, w.seq);
        shell.undo.done(`Moved to ${c.id || "Notes"}`, {
          label: "move",
          undo: async () => {
            const back = await call<Written>("records.relocate", { id, subfolder: from || null, base_version: w.info.version });
            shell.records.put(back.info, back.seq);
          },
        });
      } catch (e) {
        toast(String((e as { message?: string }).message ?? e));
      }
    },
  });
}
