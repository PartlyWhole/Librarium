/**
 * The note page: a title that renames, the editor with its autosave, and the notices (read-only,
 * recovered text, a file that has gone, another copy). Outside edits reload the text when
 * nothing is unsaved; otherwise the next save merges them.
 */
import type { EditorView } from "@codemirror/view";
import { call } from "../backend";
import { spaceFor } from "../app/folders";
import { moveTo } from "../app/folders/ops";
import type { PageContext, PageHandle } from "../app/pages";
import { beforeQuit } from "../app/quit";
import { canOpen, getRecord, listRecords, openRecord, putRecord, records } from "../app/records";
import { router } from "../app/router";
import { context, showStatus } from "../app/status";
import { attachEditor, done, editorChanged, keepText, recordScope, takeText, typed, within } from "../app/undo";
import { ask, modal } from "../ui/dialog";
import { errorText, h, replace } from "../ui/dom";
import { iconButton } from "../ui/icon";
import { effect, untracked } from "../ui/signal";
import { toast } from "../ui/toast";
import type { Draft, RecordInfo, RecordText, Written } from "../types";
import { pasted } from "./attach";
import { createEditor, historyJSON, positionOf, replaceDoc, textHistory } from "./editor/editor";
import { NoteSession, type Resolution } from "./editor/session";
import { countLabel } from "./editor/stats";
import { FolderInput } from "lucide";

/** The folder a note is in, inside notes/ ("" at the top), for making notes beside it. */
export const noteFolder = (r: RecordInfo) => r.path.split("/").slice(1, -1).join("/");

/** The notes on screen, by ID. */
const open = new Map<string, { session: NoteSession; view: EditorView }>();

/** Saves a note's unsaved text now, if it is open (before restoring a version, or exporting). */
export async function flushNote(id: string): Promise<void> {
  await open.get(id)?.session.flush();
}

/** The editor showing a note, if one is open. */
export const noteView = (id: string): EditorView | undefined => open.get(id)?.view;

/** Kinds that can be embedded (offered after `![[`). */
const EMBEDDABLE = new Set(["capture", "item", "board"]);

export function renderNote(host: HTMLElement, params: Record<string, string>, ctx: PageContext): PageHandle {
  const id = params.id ?? "";
  let alive = true;
  let cleanup: (() => void)[] = [];
  let goTo: (p: Record<string, string>) => void = () => {};

  void (async () => {
    let t: RecordText;
    try {
      t = await call<RecordText>("records.read", { id });
    } catch {
      if (alive) replace(host, h("p", { class: "empty" }, "This note can’t be found any more."));
      return;
    }
    const draft = await call<Draft | null>("drafts.get", { id }).catch(() => null);
    if (alive) cleanup = mount(host, params, ctx, t, draft, (f) => (goTo = f));
  })();

  return {
    dispose() {
      alive = false;
      for (const c of cleanup) c();
    },
    // Another place in the same note (a search hit): the cursor goes there.
    update(p) {
      goTo(p);
      return true;
    },
  };
}

function mount(host: HTMLElement, params: Record<string, string>, ctx: PageContext, t: RecordText, draft: Draft | null, setGoTo: (f: (p: Record<string, string>) => void) => void): (() => void)[] {
  const id = t.info.id;
  const scope = recordScope(id);
  const cleanup: (() => void)[] = [];
  let info = t.info;
  const readOnly = info.read_only;
  ctx.setTitle(info.title || "Untitled");

  // Text kept from an earlier run (newer than the file) is offered back.
  const recovered = draft && draft.body !== t.body ? draft : null;
  const startBody = recovered ? recovered.body : t.body;
  const notices = h("div", { class: "notices" });
  const titleInput = h("input", { class: "title-input", value: info.title, "aria-label": "Title", spellcheck: true, readOnly: !!readOnly, placeholder: "Untitled" });
  const editorHost = h("div", { class: "editor-host" });
  replace(host, titleInput, notices, editorHost);

  const session = new NoteSession(id, recovered ? recovered.base_version : info.version, recovered ? recovered.base_body : t.body, {
    current: () => view.state.doc.toString(),
    replace: (body) => replaceDoc(view, body),
    conflict: (mine, theirs, version) => resolveConflict(info.title, id, mine, theirs, version),
    status: (text, persistent) => showStatus(text, persistent ? 0 : 4000),
  });
  if (recovered) session.savedBody = t.body;

  let countTimer: ReturnType<typeof setTimeout> | undefined;
  const view: EditorView = createEditor({
    parent: editorHost,
    doc: startBody,
    // The typing history kept from the last visit (forgotten if the text changed since).
    history: takeText(scope, startBody) ?? undefined,
    onHistoryStep: () => typed(scope),
    readOnly: !!readOnly,
    label: `${info.title || "Untitled"}, note text`,
    targets: () => listRecords().filter((r) => canOpen(r) && r.id !== id).map((r) => ({ id: r.id, title: r.title, detail: r.kind === "note" ? undefined : r.kind, embeddable: EMBEDDABLE.has(r.kind) })),
    open: (target, o) => openRecord(target, {}, o),
    titleOf: (target) => untracked(() => getRecord(target))?.title ?? null,
    onChange: () => session.changed(),
    onBlur: () => void session.flush(),
    onUpdate: () => {
      clearTimeout(countTimer);
      countTimer = setTimeout(showCount, 150);
    },
    // An unresolved link's note is made beside this one.
    create: async (label) => {
      try {
        const w = await call<Written>("notes.create", { title: label, folder: noteFolder(info) || null });
        putRecord(w.info);
        return w.info.id;
      } catch (e) {
        toast(errorText(e));
        return null;
      }
    },
    onFiles: (v, files) => void pasted(v, files),
    placeholder: "Write…",
  });

  // Words and characters in the status bar, while this note is the one shown.
  const shown = () => host.isConnected && !host.closest("[hidden]");
  const showCount = () => shown() && context.set(countLabel(view.state));
  cleanup.push(effect(() => (router.active(), void queueMicrotask(showCount))));

  const mine = { session, view };
  open.set(id, mine);
  editorChanged.set(editorChanged.peek() + 1);
  const detach = attachEditor(view.dom, scope, textHistory(view));
  const unquit = beforeQuit(() => session.close());
  cleanup.push(() => {
    clearTimeout(countTimer);
    if (shown()) context.set("");
    keepText(scope, historyJSON(view), view.state.doc.toString());
    detach();
    unquit();
    if (open.get(id) === mine) open.delete(id);
    void session.close();
    view.destroy();
  });

  if (readOnly) notices.append(h("p", { class: "notice" }, `This note opens read-only. ${readOnly}`));
  if (info.conflicts.length) {
    notices.append(h("p", { class: "notice" }, `Another copy of this note exists (${info.conflicts.join(", ")}), probably from a sync conflict. `,
      h("button", { class: "link-button", onclick: () => compareCopies(info.conflicts, t.body) }, "Compare")));
  }
  if (recovered) {
    const bar = h("p", { class: "notice" }, "Text you hadn’t saved was recovered. ", h("button", { class: "link-button", onclick: () => void discard() }, "Discard it"));
    const discard = async () => {
      await call("drafts.discard", { id }).catch(() => {});
      replaceDoc(view, t.body);
      session.rebase(info.version, t.body);
      bar.remove();
    };
    notices.append(bar);
    session.changed();
  }

  // ---- The title ----
  const showTitle = (r: RecordInfo) => {
    info = r;
    if (document.activeElement !== titleInput) titleInput.value = r.title;
    ctx.setTitle(r.title || "Untitled");
  };
  /** Sets the title (the file name follows); each step expects the version the last one made. */
  const retitle = async (title: string, base?: string) => {
    const w = await call<Written>("records.relocate", { id, title, ...(base ? { base_version: base } : {}) });
    putRecord(w.info);
    session.rebase(w.info.version, session.savedBody);
    if (document.activeElement !== titleInput) titleInput.value = title;
    showTitle(w.info);
    return w.info.version;
  };
  const rename = async () => {
    const title = titleInput.value.replace(/\s+/g, " ").trim();
    const before = info.title;
    if (!title || title === before) return void (titleInput.value = before);
    try {
      let version = await retitle(title);
      done(`Renamed to “${title}”.`, {
        label: `rename to “${title}”`,
        undo: async () => void (version = await retitle(before, version)),
        redo: async () => void (version = await retitle(title, version)),
      }, scope);
    } catch (e) {
      titleInput.value = info.title;
      toast(errorText(e));
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

  const move = iconButton(FolderInput, "Move to folder", () => {
    const r = getRecord(id);
    const sp = r && spaceFor(r.kind);
    if (r && sp) void within(scope, () => moveTo(sp, [r]));
  });
  move.disabled = !!readOnly;
  ctx.setHeaderActions([move]);

  // ---- Changes to the file ----
  let gone: HTMLElement | null = null;
  let seen = info.version;
  cleanup.push(effect(() => {
    const r = records().get(id);
    if (!r) {
      // Gone (deleted or moved away outside the app): said once; the text stays on screen.
      if (!gone && records().size) notices.prepend((gone = h("p", { class: "notice" }, "This note can’t be found any more. Your text is still here; copy it to keep it.")));
      return;
    }
    gone?.remove();
    gone = null;
    if (r.version === seen) return;
    seen = r.version;
    untracked(() => void reload());
  }));
  const reload = async () => {
    const fresh = await call<RecordText>("records.read", { id }).catch(() => null);
    // Our own saves are shown already.
    if (!fresh || fresh.info.version === session.baseVersion) return;
    if (fresh.body === session.baseBody) session.rebase(fresh.info.version, fresh.body);
    else if (!session.dirty) {
      replaceDoc(view, fresh.body);
      session.rebase(fresh.info.version, fresh.body);
    }
    showTitle(fresh.info);
  };

  // ---- Where to start ----
  const place = (p: Record<string, string>) => {
    if (p.at) {
      const pos = positionOf(view, Number(p.at));
      view.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
      view.focus();
    } else if (p.focus === "title") {
      titleInput.focus();
      titleInput.select();
    } else if (!readOnly) view.focus();
  };
  setGoTo(place);
  place(params);
  return cleanup;
}

/** Changes made outside overlap the user's: they choose, and nothing is lost either way. */
async function resolveConflict(title: string, id: string, mine: string, theirs: string, version: string): Promise<Resolution | null> {
  const col = (label: string, text: string) => h("div", { class: "compare-col" }, h("h3", null, label), h("pre", { class: "compare-text" }, text));
  const choice = await ask(`“${title}” changed outside Librarium`,
    [h("p", null, "Those changes overlap yours, so they can’t be merged automatically. Nothing has been overwritten."), h("div", { class: "compare" }, col("Yours", mine), col("On disk", theirs))],
    [
      { label: "Keep both", value: "both" },
      { label: "Use the version on disk", value: "theirs" },
      { label: "Keep yours", value: "mine", primary: true },
    ]);
  if (choice === "mine") return { body: mine, version, baseBody: theirs };
  if (choice === "theirs") {
    await call("drafts.discard", { id }).catch(() => {});
    return { body: theirs, version, baseBody: theirs };
  }
  if (choice === "both") {
    try {
      const r = getRecord(id);
      const w = await call<Written>("notes.create", { title: `${title} (your version)`, body: mine, folder: r ? noteFolder(r) || null : null });
      putRecord(w.info);
      toast(`Your version was kept as “${w.info.title}”.`);
    } catch (e) {
      toast(errorText(e));
      return null;
    }
    return { body: theirs, version, baseBody: theirs };
  }
  return null;
}

function compareCopies(paths: string[], body: string): void {
  const m = modal(
    h("div", { class: "ask" },
      h("h2", { class: "ask-title" }, "Two copies of this note"),
      h("p", null, `The other copy is at ${paths.join(", ")}. Open it in Finder to compare, or keep this one and remove the other yourself.`),
      h("pre", { class: "compare-text" }, body),
      h("div", { class: "ask-buttons" }, h("button", { class: "button primary", onclick: () => m.close() }, "Done"))),
    { label: "Two copies of this note" },
  );
}
