/**
 * The board page: Excalidraw for one board, its title (renames are undoable), the drawing and
 * its readable page saved together a second after a change, a draft that survives a crash,
 * changes made elsewhere, ⌘Z through the board's place, and the board's own commands (link,
 * put on the board, export).
 */
import { BackendError, call, onFileDrop, pickSavePath } from "../backend";
import { folderOf, spaceFor } from "../app/folders";
import { moveTo } from "../app/folders/ops";
import { askToOpen } from "../app/links";
import type { PageContext, PageHandle } from "../app/pages";
import { beforeQuit } from "../app/quit";
import { canOpen, getRecord, isArchived, kindName, listRecords, openRecord, putRecord, recordIcon, records } from "../app/records";
import { router } from "../app/router";
import { ATTACHMENTS, base64, isImagePath, MAX_PASTE, OWN_DROPS, pastedName } from "../library/files";
import { showStatus } from "../app/status";
import { attachEditor, done, recordScope, takeText, typed, within } from "../app/undo";
import { comboboxDialog } from "../ui/combobox";
import { dropTarget } from "../ui/dnd";
import { errorText, h, replace } from "../ui/dom";
import { iconButton } from "../ui/icon";
import { effect, untracked } from "../ui/signal";
import { toast } from "../ui/toast";
import type { BoardLoaded, BoardSaved, Draft, ImportResult, Written } from "../types";
import type { BoardEngine, BoardInsert } from "./engine";
import { boardOutline, boardPage } from "./mirror";
import { recordOf, type BoardElement, type BoardLink } from "./links";
import { renderCard } from "./cards";
import { appTheme, isPicture, loadEngine, pictureData, portable } from "./shared";
import { FolderInput } from "lucide";

const SAVE_MS = 1000;
const DRAFT_MS = 300;
const RETRY_MS = 5000;

type ExportAs = "png" | "svg" | "excalidraw";

/** What the board's commands act on, for each board on screen. */
const shownBoards = new Map<string, { linkTo(): void; insert(): void; exportAs(as: ExportAs): Promise<void> }>();

/** The board in the tab shown, if it is one. */
export function shownBoard() {
  const r = router.current();
  return r.page === "board" ? shownBoards.get(r.params.id ?? "") : undefined;
}

const elementsOf = (scene: string): BoardElement[] => {
  try {
    return (JSON.parse(scene) as { elements?: BoardElement[] }).elements ?? [];
  } catch {
    return [];
  }
};
const titleOf = (id: string) => untracked(() => getRecord(id))?.title || null;

/** Asks which record (anything that opens, but this board). */
function pickRecord(self: string, label: string, picked: (to: BoardLink) => void): void {
  const choices = untracked(listRecords).filter((r) => r.id !== self && canOpen(r)).map((r) => ({ id: r.id, label: r.title || "Untitled", detail: r.kind === "note" ? undefined : kindName(r), icon: recordIcon(r) }));
  comboboxDialog({ label, placeholder: "Type a title", emptyText: "Nothing has that title.", choices, onPick: (c) => picked({ id: c.id, label: c.label }) });
}

export function renderBoard(host: HTMLElement, params: Record<string, string>, ctx: PageContext): PageHandle {
  const id = params.id ?? "";
  let alive = true;
  const cleanup: (() => void)[] = [];
  host.classList.add("board-page");

  void (async () => {
    let loaded: BoardLoaded;
    try {
      loaded = await call<BoardLoaded>("boards.load", { id });
    } catch {
      if (alive) replace(host, h("p", { class: "empty" }, "This board can’t be found any more."));
      return;
    }
    const draft = await call<Draft | null>("drafts.get", { id }).catch(() => null);
    if (alive) await mount(host, params, ctx, loaded, draft, cleanup, () => alive);
  })();

  return () => {
    alive = false;
    for (const c of cleanup.splice(0)) c();
  };
}

async function mount(host: HTMLElement, params: Record<string, string>, ctx: PageContext, loaded: BoardLoaded, draft: Draft | null, cleanup: (() => void)[], alive: () => boolean): Promise<void> {
  const id = loaded.info.id;
  const scope = recordScope(id);
  let info = loaded.info;
  const readOnly = !!info.read_only;
  ctx.setTitle(info.title || "Untitled board");
  // A drawing not saved before the app stopped comes back (its draft differs from the file).
  const recovered = draft && draft.body !== loaded.scene && !readOnly ? draft : null;
  // What the next save is based on: the version and drawing it was opened from.
  let base = recovered ? { version: recovered.base_version, sha: recovered.base_body } : { version: info.version, sha: loaded.scene_sha };

  const titleInput = h("input", { class: "title-input", value: info.title, "aria-label": "Title", spellcheck: true, readOnly, placeholder: "Untitled board" });
  const notices = h("div", { class: "notices" });
  const outline = h("ul", { class: "board-outline", "aria-label": "What is on the board" });
  const canvasHost = h("div", { class: "board-host", role: "region", "aria-label": `Drawing: ${info.title || "Untitled board"}`, [OWN_DROPS]: "" });
  replace(host, h("div", { class: "board-head" }, titleInput, notices), canvasHost, outline);
  const status = (text: string, persistent = false) => showStatus(text, persistent ? 0 : 4000);
  let engine: BoardEngine | null = null;

  // ---- What is on it, for VoiceOver ----
  let outlineTimer: ReturnType<typeof setTimeout> | undefined;
  const tellOutline = () => {
    clearTimeout(outlineTimer);
    outlineTimer = setTimeout(() => {
      if (!engine) return;
      const lines = boardOutline(engine.current().elements, titleOf);
      replace(outline, ...(lines.length ? lines.map((l) => h("li", null, l)) : [h("li", null, "Nothing yet.")]));
    }, 400);
  };
  cleanup.push(() => clearTimeout(outlineTimer));

  // ---- Saving ----
  let dirty = false;
  let saving: Promise<void> | null = null;
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  let draftTimer: ReturnType<typeof setTimeout> | undefined;
  const keepDraft = () => {
    if (engine && !readOnly) void call("drafts.put", { id, base_version: base.version, base_body: base.sha, body: engine.current().scene }).catch(() => {});
  };
  const changed = () => {
    tellOutline();
    if (readOnly) return;
    dirty = true;
    clearTimeout(draftTimer);
    draftTimer = setTimeout(keepDraft, DRAFT_MS);
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => void save(), SAVE_MS);
  };
  /** Saves what is unsaved (`snap`: the drawing taken just before the canvas goes). */
  const save = async (snap?: ReturnType<BoardEngine["current"]> | null): Promise<void> => {
    if (saving) await saving;
    if (!dirty || (!engine && !snap) || readOnly) return;
    clearTimeout(saveTimer);
    dirty = false;
    const { scene, elements } = snap ?? engine!.current();
    saving = (async () => {
      try {
        const r = await call<BoardSaved>("boards.save", { id, base_version: base.version, base_scene_sha: base.sha, scene, page: boardPage(id, elements, titleOf) });
        base = { version: r.info.version, sha: r.scene_sha };
        info = r.info;
        putRecord(r.info);
        if (!dirty) {
          clearTimeout(draftTimer);
          await call("drafts.discard", { id }).catch(() => {});
        }
      } catch (e) {
        dirty = true;
        if (e instanceof BackendError && e.code === "conflict") await keepTheirs();
        else {
          status(`The board couldn’t be saved: ${errorText(e)}. It is kept, and saving is tried again.`, true);
          saveTimer = setTimeout(() => void save(), RETRY_MS);
        }
      }
    })();
    await saving;
    saving = null;
    if (dirty && alive() && engine) saveTimer = setTimeout(() => void save(), SAVE_MS);
  };
  /**
   * The board changed elsewhere while it had unsaved changes here: the other version is kept as
   * a board beside it, and this one is saved over it. Never merged silently.
   */
  const keepTheirs = async () => {
    try {
      const fresh = await call<BoardLoaded>("boards.load", { id });
      // Only the readable page changed (names refreshed): it is rewritten anyway.
      if (fresh.scene_sha !== base.sha) {
        const w = await call<Written>("boards.create", { title: `${info.title} (version from elsewhere)`, folder: folderOf(info) || null });
        const copy = await call<BoardLoaded>("boards.load", { id: w.info.id });
        const saved = await call<BoardSaved>("boards.save", { id: w.info.id, base_version: copy.info.version, base_scene_sha: copy.scene_sha, scene: fresh.scene, page: boardPage(w.info.id, elementsOf(fresh.scene), titleOf) });
        putRecord(saved.info);
        toast(`“${info.title}” was also changed elsewhere. That version was kept as “${saved.info.title}”; yours stays here.`, { action: { label: "Open it", run: () => openRecord(saved.info.id) } });
      }
      base = { version: fresh.info.version, sha: fresh.scene_sha };
      info = fresh.info;
    } catch (e) {
      status(`The board changed elsewhere and couldn’t be kept apart: ${errorText(e)}`, true);
    }
  };
  cleanup.push(beforeQuit(() => save()));
  cleanup.push(() => {
    clearTimeout(draftTimer);
    clearTimeout(saveTimer);
    // Taken now: the canvas goes next.
    void save(dirty && engine ? engine.current() : null);
  });

  // ---- The drawing ----
  let module: Awaited<ReturnType<typeof loadEngine>>;
  try {
    module = await loadEngine();
  } catch (e) {
    if (alive()) replace(canvasHost, h("p", { class: "empty" }, `The drawing tools couldn’t be loaded: ${errorText(e)}`));
    return;
  }
  if (!alive()) return;
  // Drawing steps from an earlier visit are forgotten; steps done to the board (renames) stay.
  takeText(scope, "");
  const ready = await module.mountBoard(canvasHost, {
    scene: recovered ? recovered.body : loaded.scene,
    theme: appTheme(),
    readOnly,
    onChange: changed,
    onStep: () => typed(scope, "Drawing"),
    onFiles: (files) => void pasted(files),
    renderCard,
    imageOf: pictureData,
    onLinkStart: (elementId) => pickRecord(id, "Link this text to", (to) => engine?.link([elementId], to, { replaceTyped: true })),
    onOpenLink: (link, newTab) => {
      const target = recordOf(link);
      if (target) openRecord(target, {}, { newTab });
      else void askToOpen(link, { from: info.title });
    },
  });
  if (!alive()) return ready.destroy();
  engine = ready;
  tellOutline();
  const detach = attachEditor(engine.el, scope, { undo: () => ready.undo(), redo: () => ready.redo(), canUndo: () => true, canRedo: () => true, isolate() {} });
  cleanup.push(() => {
    detach();
    ready.destroy();
  });
  // The canvas follows the app's look.
  const sync = () => ready.setTheme(appTheme());
  const themeWatch = new MutationObserver(sync);
  themeWatch.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  const media = window.matchMedia?.("(prefers-color-scheme: dark)");
  media?.addEventListener?.("change", sync);
  cleanup.push(() => (themeWatch.disconnect(), media?.removeEventListener?.("change", sync)));

  if (readOnly) notices.append(h("p", { class: "notice" }, `This board opens read-only. ${info.read_only}`));
  if (recovered) {
    const bar = h("p", { class: "notice" }, "A drawing you hadn’t saved was recovered. ", h("button", { class: "link-button", onclick: () => void discard() }, "Discard it"));
    const discard = async () => {
      await call("drafts.discard", { id }).catch(() => {});
      ready.load(loaded.scene);
      base = { version: info.version, sha: loaded.scene_sha };
      dirty = false;
      bar.remove();
    };
    notices.append(bar);
    changed();
  } else if (loaded.stale_page && !readOnly) changed(); // The page was written from another drawing.

  // ---- Putting things on it ----
  /** Records put on the board: pictures as pictures, the rest as cards. */
  const insertRecords = (ids: string[], at?: { x: number; y: number }) => {
    const items: BoardInsert[] = ids.flatMap((rid) => {
      const r = untracked(() => getRecord(rid));
      if (!r || rid === id) return [];
      return [{ id: rid, label: r.title || "Untitled", picture: isPicture(r), embed: r.kind === "capture" || isPicture(r) }];
    });
    if (items.length) void ready.insert(items, at);
  };
  /** Pasted pictures become library items in Attachments, then go on the board. */
  const pasted = async (files: File[]) => {
    const ids: string[] = [];
    for (const f of files) {
      if (f.size > MAX_PASTE) {
        toast(`“${f.name || "That picture"}” is too large to paste (over 50 MB); add it as a file.`);
        continue;
      }
      try {
        const w = await call<Written>("library.importData", { name: pastedName(f), data: base64(new Uint8Array(await f.arrayBuffer())), folder: ATTACHMENTS });
        putRecord(w.info);
        ids.push(w.info.id);
      } catch (e) {
        toast(errorText(e));
      }
    }
    insertRecords(ids);
  };
  /** Files dropped from Finder: pictures go to Attachments, documents to the Library's top. */
  const dropped = async (paths: string[], at: { x: number; y: number }) => {
    const ids: string[] = [];
    for (const [list, folder] of [[paths.filter(isImagePath), ATTACHMENTS], [paths.filter((p) => !isImagePath(p)), null]] as const) {
      if (!list.length) continue;
      try {
        const r = await call<ImportResult>("library.import", { paths: list, ...(folder ? { folder } : {}) });
        for (const f of r.failed) toast(f.error);
        for (const w of r.imported) (putRecord(w.info), ids.push(w.info.id));
      } catch (e) {
        toast(errorText(e));
      }
    }
    insertRecords(ids, at);
  };
  cleanup.push(onFileDrop((paths, at) => {
    const over = document.elementFromPoint(at.x, at.y);
    if (!over || !canvasHost.contains(over)) return;
    if (readOnly) toast("This board is read-only, so nothing can be put on it.");
    else void dropped(paths, at);
  }));
  // Records dragged from the sidebar or a folder page.
  let dropAt: { x: number; y: number } | undefined;
  dropTarget(canvasHost, {
    accepts: (p) => !readOnly && p.records.length > 0 && !p.records.includes(id),
    where: (_p, x, y) => ((dropAt = { x, y }), "into"),
    drop: (p) => insertRecords(p.records, dropAt),
  });

  // ---- The board's commands ----
  const linkTo = () => {
    const ids = ready.selected();
    if (!ids.length) return status("Select something on the board first, then link it.");
    pickRecord(id, ids.length === 1 ? "Link it to" : `Link ${ids.length} things to`, (to) => ready.link(ids, to));
  };
  /** The board as a picture or a file: saved first, then written where asked. */
  const exportAs = async (as: ExportAs) => {
    await save();
    const scene = ready.current().scene;
    const name = (info.title || "Board").replace(/[/:\\]/g, "-");
    const how = { png: "as a picture (PNG)", svg: "as a picture (SVG)", excalidraw: "as an Excalidraw file" }[as];
    const path = await pickSavePath(`${name}.${as}`, `Export “${info.title}” ${how}`);
    if (!path) return;
    try {
      const dark = appTheme() === "dark";
      if (as === "png") await call("export.write", { path, data: base64(new Uint8Array(await (await module.boardPng(scene, portable, dark)).arrayBuffer())) });
      else if (as === "svg") await call("export.write", { path, text: (await module.boardSvg(scene, portable, dark)).outerHTML });
      else await call("export.write", { path, text: await module.portableFile(scene, portable) });
      status(as === "excalidraw" ? "Exported, with its pictures inside and its cards written out." : "Exported.");
    } catch (e) {
      toast(`The board couldn’t be exported: ${errorText(e)}`);
    }
  };
  shownBoards.set(id, { linkTo, insert: () => pickRecord(id, "Put on the board", (to) => insertRecords([to.id])), exportAs });
  cleanup.push(() => shownBoards.delete(id));

  // ---- Changes made elsewhere ----
  let seen = info.version;
  cleanup.push(effect(() => {
    const r = records().get(id);
    if (!r || r.version === seen) return;
    seen = r.version;
    untracked(() => void reload());
  }));
  const reload = async () => {
    const fresh = await call<BoardLoaded>("boards.load", { id }).catch(() => null);
    if (!fresh || !alive() || fresh.info.version === base.version) return;
    info = fresh.info;
    showTitle(fresh.info.title);
    // With nothing unsaved, the drawing on disk is shown; otherwise the next save keeps both.
    if (!dirty && fresh.scene_sha !== base.sha) ready.load(fresh.scene);
    if (!dirty || fresh.scene_sha === base.sha) base = { version: fresh.info.version, sha: fresh.scene_sha };
  };

  // ---- The title ----
  const showTitle = (title: string) => {
    if (document.activeElement !== titleInput) titleInput.value = title;
    ctx.setTitle(title || "Untitled board");
    canvasHost.setAttribute("aria-label", `Drawing: ${title || "Untitled board"}`);
  };
  const retitle = async (to: string) => {
    await save();
    const w = await call<Written>("records.relocate", { id, title: to, base_version: base.version });
    info = w.info;
    seen = w.info.version;
    base = { ...base, version: w.info.version };
    putRecord(w.info);
    titleInput.value = to;
    showTitle(to);
  };
  const rename = async () => {
    const title = titleInput.value.replace(/\s+/g, " ").trim();
    const before = info.title;
    if (!title || title === before) return void (titleInput.value = before);
    try {
      await retitle(title);
      done(`Renamed to “${title}”`, { label: `rename to “${title}”`, undo: () => retitle(before), redo: () => retitle(title) }, scope);
    } catch (e) {
      titleInput.value = info.title;
      toast(errorText(e));
    }
  };
  titleInput.addEventListener("keydown", (e) => {
    if (e.isComposing || (e.key !== "Enter" && e.key !== "Escape")) return;
    e.preventDefault();
    if (e.key === "Escape") titleInput.value = info.title;
    titleInput.blur();
  });
  titleInput.addEventListener("blur", () => void rename());

  const move = iconButton(FolderInput, "Move to folder", () => {
    const r = getRecord(id);
    const sp = r && spaceFor(r.kind);
    if (r && sp && !isArchived(r)) void save().then(() => within(scope, () => moveTo(sp, [r])));
  });
  move.disabled = readOnly;
  ctx.setHeaderActions([move]);
  if (params.focus === "title") {
    titleInput.focus();
    titleInput.select();
  }
}
