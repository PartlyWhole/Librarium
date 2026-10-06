/**
 * The board page (docs/plans/boards.md, phase 2): Excalidraw for one board, its title (renames),
 * autosave of the drawing and its readable page together, drafts that survive a crash, outside
 * changes, and ⌘Z through the board's place (decision 0060).
 */
import { call, on, readBytes, BackendCallError } from "../../backend";
import { h, replace } from "../../kit/dom";
import { icon } from "../../kit/icon";
import { toast } from "../../kit/toast";
import { recordScope } from "../../shell/undo";
import type { ShellApi } from "../../shell/api";
import type { PageContext } from "../../shell/slots";
import type { BoardLoaded } from "../../generated/BoardLoaded";
import type { BoardSaved } from "../../generated/BoardSaved";
import type { Change } from "../../generated/Change";
import type { Draft } from "../../generated/Draft";
import type { Written } from "../../generated/Written";
import type { BoardElement, BoardEngine, BoardEngineOptions, BoardInsert } from "./engine";
import { boardPage } from "./mirror";
import { recordOf } from "./links";
import { comboboxDialog } from "../../kit/combobox";
import { dropTarget } from "../../kit/dnd";
import { effect, untracked } from "../../kit/signal";
import type { RecordInfo } from "../../generated/RecordInfo";
import { askToOpen } from "../../shell/links";
import { FolderInput } from "lucide";

/** How long after the last change the board is saved, and its draft kept (tests shorten them). */
export const boardTimings = { save: 1000, draft: 300, retry: 5000 };

type Mount = (host: HTMLElement, o: BoardEngineOptions) => Promise<BoardEngine>;
/** Excalidraw, loaded when a board first opens (its fonts are the app's own, 0061). */
let loadEngine = async (): Promise<Mount> => {
  (window as unknown as { EXCALIDRAW_ASSET_PATH: string }).EXCALIDRAW_ASSET_PATH = "/excalidraw/";
  return (await import("./engine")).mountBoard;
};
/** Tests stand in their own engine (Excalidraw needs a real browser). */
export function useBoardEngine(mount: Mount): void {
  loadEngine = async () => mount;
}

/** The boards shown, by ID: what the board's commands act on (Link to…, Insert…). */
export const shownBoards = new Map<string, { linkTo(): void; insert(): void }>();

/**
 * Whether a record is a picture (a library item whose original is an image: the library
 * feature's `library.format`). Pictures go on a board as pictures, anything else as a card.
 */
const isPicture = (r: RecordInfo | undefined) => r?.kind === "item" && r.fields["library.format"] === "image";
const MIME: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml", heic: "image/heic", tif: "image/tiff", tiff: "image/tiff", bmp: "image/bmp" };

/** A picture's data and size, from the library. */
async function pictureData(r: RecordInfo): Promise<{ dataURL: string; mimeType: string; width: number; height: number } | null> {
  const ext = String(r.fields["library.original"] ?? "").split(".").pop()?.toLowerCase() ?? "";
  const mimeType = MIME[ext] ?? "image/png";
  const bytes = new Uint8Array(await readBytes(r.id));
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  const dataURL = `data:${mimeType};base64,${btoa(bin)}`;
  const size = await new Promise<{ width: number; height: number }>((resolve) => {
    // A picture that never loads still goes on the board, at a usual size.
    setTimeout(() => resolve({ width: 400, height: 300 }), 3000);
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth || 400, height: img.naturalHeight || 300 });
    img.onerror = () => resolve({ width: 400, height: 300 });
    img.src = dataURL;
  });
  return { dataURL, mimeType, ...size };
}

/** The app's light or dark look now. */
function appTheme(): "light" | "dark" {
  const t = document.documentElement.dataset.theme;
  return t === "dark" || (t !== "light" && !!window.matchMedia?.("(prefers-color-scheme: dark)").matches) ? "dark" : "light";
}

const message = (e: unknown) => String((e as { message?: string })?.message ?? e);
const elementsOf = (scene: string): BoardElement[] => {
  try {
    return (JSON.parse(scene) as { elements?: BoardElement[] }).elements ?? [];
  } catch {
    return [];
  }
};

export function renderBoard(shell: ShellApi, host: HTMLElement, params: Record<string, string>, ctx: PageContext): () => void {
  const id = params.id ?? "";
  const scope = recordScope(id);
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
    if (!alive) return;
    let info = loaded.info;
    const readOnly = !!info.read_only;
    ctx.setTitle(info.title || "Untitled board");
    // A drawing not saved before the app stopped is given back (its draft is newer than the file).
    const recovered = draft && draft.body !== loaded.scene && !readOnly ? draft : null;
    // What the next save is based on: the version and drawing it was opened from.
    let base = recovered ? { version: recovered.base_version, sha: recovered.base_body } : { version: info.version, sha: loaded.scene_sha };

    const titleInput = h("input", { class: "title-input board-title", value: info.title, "aria-label": "Title", spellcheck: true, readOnly, placeholder: "Untitled board" }) as HTMLInputElement;
    const notices = h("div", { class: "notices" });
    const canvasHost = h("div", { class: "board-host" });
    replace(host, h("div", { class: "board-head" }, titleInput, notices), canvasHost);
    const status = (text: string, persistent = false) => shell.status.show(text, persistent ? 0 : 4000);

    /** A record's name now (the readable page writes links with it). */
    const titleOf = (rid: string) => shell.records.get(rid)?.title || null;

    /**
     * A card on the board: a capture's quotation and citation, an item or a note, drawn as notes
     * draw embeds (`shell.embeds`), and drawn again when the record changes.
     */
    function renderCard(rid: string, host: HTMLElement): () => void {
      const open = (to: string, params?: Record<string, string>, opts?: { newTab?: boolean }) => shell.openRecord(to, params ?? {}, opts);
      let shownVersion: string | null = null;
      return effect(() => {
        const r = shell.records.get(rid);
        if ((r?.version ?? "") === shownVersion) return;
        shownVersion = r?.version ?? "";
        untracked(() => {
          if (!r) return replace(host, h("div", { class: "board-card missing" }, "This was deleted or can’t be found."));
          const look = shell.looks.get(r.kind);
          const renderer = r.kind === "note" ? undefined : shell.embeds.get(r.kind);
          const body = renderer
            ? renderer.render(r, open)
            : h("a", { href: "#", class: "board-card-link", onclick: (e: Event) => (e.preventDefault(), open(r.id)) }, look ? icon(look.icon(r), 16) : null, h("span", null, r.title || "Untitled"), h("span", { class: "muted small" }, look?.kindName(r) ?? r.kind.charAt(0).toUpperCase() + r.kind.slice(1)));
          const archived = shell.records.isHidden(r) ? h("p", { class: "muted small" }, "In the archive.") : null;
          replace(host, h("div", { class: `board-card kind-${r.kind}` }, body, archived));
        });
      });
    }

    // ---- saving ----------------------------------------------------------------------------
    let engine: BoardEngine | null = null;
    let dirty = false;
    let saving: Promise<void> | null = null;
    let saveTimer: ReturnType<typeof setTimeout> | undefined;
    let draftTimer: ReturnType<typeof setTimeout> | undefined;
    const keepDraft = () => {
      if (!engine || readOnly) return;
      void call("drafts.put", { id, base_version: base.version, base_body: base.sha, body: engine.current().scene }).catch(() => {});
    };
    const changed = () => {
      if (readOnly) return;
      dirty = true;
      clearTimeout(draftTimer);
      draftTimer = setTimeout(keepDraft, boardTimings.draft);
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => void save(), boardTimings.save);
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
          shell.records.put(r.info, r.seq);
          if (!dirty) {
            clearTimeout(draftTimer);
            await call("drafts.discard", { id }).catch(() => {});
          }
        } catch (e) {
          dirty = true;
          if (e instanceof BackendCallError && e.code === "conflict") await keepTheirs();
          else {
            status(`The board couldn’t be saved: ${message(e)}. It is kept, and saving is tried again.`, true);
            saveTimer = setTimeout(() => void save(), boardTimings.retry);
          }
        }
      })();
      await saving;
      saving = null;
      if (dirty && alive && engine) saveTimer = setTimeout(() => void save(), boardTimings.save);
    };
    /**
     * The board was changed elsewhere while it had unsaved changes here: never merged silently
     * (0017). The other version is kept as a copy beside it; this one is saved over it.
     */
    const keepTheirs = async () => {
      try {
        const fresh = await call<BoardLoaded>("boards.load", { id });
        // Only the readable page changed (links' names refreshed after a rename, or the page
        // edited outside): it is written from the drawing anyway, so this save goes ahead.
        if (fresh.scene_sha === base.sha) {
          base = { version: fresh.info.version, sha: fresh.scene_sha };
          info = fresh.info;
          return;
        }
        const folder = info.path.split("/").slice(1, -1).join("/") || undefined;
        const w = await call<Written>("boards.create", { title: `${info.title} (version from elsewhere)`, folder });
        const copy = await call<BoardLoaded>("boards.load", { id: w.info.id });
        const saved = await call<BoardSaved>("boards.save", { id: w.info.id, base_version: copy.info.version, base_scene_sha: copy.scene_sha, scene: fresh.scene, page: boardPage(w.info.id, elementsOf(fresh.scene)) });
        shell.records.put(saved.info, saved.seq);
        base = { version: fresh.info.version, sha: fresh.scene_sha };
        toast(`“${info.title}” was also changed elsewhere. That version was kept as “${saved.info.title}”; yours stays here.`, { action: { label: "Open it", run: () => shell.openRecord(saved.info.id) } });
      } catch (e) {
        status(`The board changed elsewhere and couldn’t be kept apart: ${message(e)}`, true);
      }
    };
    cleanup.push(shell.beforeClose(() => save()));
    cleanup.push(() => {
      clearTimeout(draftTimer);
      clearTimeout(saveTimer);
      // Taken now: the canvas goes next.
      void save(dirty && engine ? engine.current() : null);
    });

    // ---- the drawing -----------------------------------------------------------------------
    let mount: Mount;
    try {
      mount = await loadEngine();
    } catch (e) {
      if (alive) replace(canvasHost, h("p", { class: "empty" }, `The drawing tools couldn’t be loaded: ${message(e)}`));
      return;
    }
    if (!alive) return;
    // This board's history: Excalidraw keeps its steps while the board is open; leaving forgets
    // them (steps done to the board on its page, like renaming, stay).
    shell.undo.takeText(scope, "");
    const ready = await mount(canvasHost, {
      scene: recovered ? recovered.body : loaded.scene,
      theme: appTheme(),
      readOnly,
      onChange: changed,
      onStep: () => shell.undo.typed(scope, "Drawing"),
      // Pasted pictures: attached by the library (as in notes), then put here.
      onFiles: (files) => void canvasHost.dispatchEvent(new CustomEvent("librarium:files", { bubbles: true, detail: { files } })),
      renderCard,
      imageOf: async (rid) => {
        const r = shell.records.get(rid);
        return r ? pictureData(r).catch(() => null) : null;
      },
      // `[[` typed in a text: what to link it to.
      onLinkStart: (elementId) => pickRecord("Link this text to", (to) => engine?.link([elementId], to, { replaceTyped: true })),
      onOpenLink: (link, newTab) => {
        const target = recordOf(link);
        if (target) shell.openRecord(target, {}, { newTab });
        else void askToOpen(link, { from: info.title });
      },
    });
    if (!alive) return ready.destroy();
    engine = ready;
    const detach = shell.undo.attachText(scope, { undo: () => engine!.undo(), redo: () => engine!.redo(), isolate() {} }, engine.el);
    cleanup.push(() => {
      detach();
      engine?.destroy();
    });
    // The look follows the app's.
    const sync = () => engine?.setTheme(appTheme());
    const themeWatch = new MutationObserver(sync);
    themeWatch.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    const media = window.matchMedia?.("(prefers-color-scheme: dark)");
    media?.addEventListener?.("change", sync);
    cleanup.push(() => (themeWatch.disconnect(), media?.removeEventListener?.("change", sync)));

    if (readOnly) notices.appendChild(h("p", { class: "notice" }, `This board opens read-only. ${info.read_only}`));
    if (recovered) {
      const bar = h("p", { class: "notice" }, "A drawing you hadn’t saved was recovered. ", h("button", { class: "link-button", onclick: () => void discard() }, "Discard it"));
      const discard = async () => {
        await call("drafts.discard", { id }).catch(() => {});
        engine?.load(loaded.scene);
        base = { version: info.version, sha: loaded.scene_sha };
        dirty = false;
        bar.remove();
      };
      notices.appendChild(bar);
      changed();
    } else if (loaded.stale_page && !readOnly) {
      // The page was written from another drawing (changed outside, or a save cut short).
      changed();
    }

    // ---- cards and pictures ------------------------------------------------------------------
    /** Records put on the board: pictures, or cards (captures as quotations, written ![[…]]). */
    const toInsert = (ids: string[]): BoardInsert[] =>
      ids.flatMap((rid) => {
        const r = shell.records.get(rid);
        if (!r || rid === id) return [];
        return [{ id: rid, label: r.title || "Untitled", picture: isPicture(r), embed: r.kind === "capture" || isPicture(r) }];
      });
    const insertRecords = (ids: string[], at?: { x: number; y: number }) => {
      const items = toInsert(ids);
      if (items.length) void engine?.insert(items, at);
    };
    // Pictures pasted or dropped from Finder, attached by the library, come back here.
    canvasHost.dataset.takesEmbeds = "";
    canvasHost.addEventListener("librarium:insert-embeds", (ev) => {
      const d = (ev as CustomEvent<{ links: { id: string }[]; x?: number; y?: number }>).detail;
      insertRecords(d.links.map((l) => l.id), d.x !== undefined && d.y !== undefined ? { x: d.x, y: d.y } : undefined);
    });
    // Records dragged from the sidebar or a folder page.
    let dropAt: { x: number; y: number } | undefined;
    dropTarget(canvasHost, {
      accepts: (p) => !readOnly && p.records.length > 0 && !p.records.includes(id),
      where: (_p, x, y) => ((dropAt = { x, y }), "into"),
      drop: (p) => insertRecords(p.records, dropAt),
    });
    const insert = () =>
      pickRecord("Put on the board", (to) => insertRecords([to.id]));

    // ---- links -----------------------------------------------------------------------------
    /** Asks which record (anything that opens: notes, boards, items, captures). */
    function pickRecord(label: string, done: (to: { id: string; label: string }) => void) {
      const choices = shell.records
        .list()
        .filter((r) => r.id !== id && shell.openers.get(r.kind) && !shell.records.isHidden(r))
        .map((r) => ({ id: r.id, label: r.title || "Untitled", detail: r.kind === "note" ? undefined : (shell.looks.get(r.kind)?.kindName(r) ?? r.kind.charAt(0).toUpperCase() + r.kind.slice(1)), icon: shell.looks.get(r.kind)?.icon(r) }));
      comboboxDialog({ label, placeholder: "Type a title", emptyText: "Nothing has that title.", choices, onPick: (c) => done({ id: c.id, label: c.label }) });
    }
    const linkTo = () => {
      const ids = engine?.selected() ?? [];
      if (!ids.length) return status("Select something on the board first, then link it.");
      pickRecord(ids.length === 1 ? "Link it to" : `Link ${ids.length} things to`, (to) => engine?.link(ids, to));
    };
    shownBoards.set(id, { linkTo, insert });
    cleanup.push(() => shownBoards.delete(id));

    // ---- outside changes -------------------------------------------------------------------
    cleanup.push(
      on("event.change", (p) => {
        const c = p as Change;
        if (c.id !== id || c.op === "removed") return;
        void call<BoardLoaded>("boards.load", { id }).then((fresh) => {
          if (!alive || fresh.info.version === base.version) return;
          info = fresh.info;
          titleInput.value = fresh.info.title;
          ctx.setTitle(fresh.info.title);
          // With nothing unsaved, the drawing shown becomes the one on disk; otherwise the
          // next save keeps both (keepTheirs). When only the page changed (names refreshed),
          // the drawing is the same: the next save is based on the new version.
          if (!dirty && fresh.scene_sha !== base.sha) engine?.load(fresh.scene);
          if (!dirty || fresh.scene_sha === base.sha) base = { version: fresh.info.version, sha: fresh.scene_sha };
        }, () => {});
      }),
    );

    // ---- the title -------------------------------------------------------------------------
    const retitle = async (to: string, version: string) => {
      const x = await call<Written>("records.relocate", { id, title: to, base_version: version });
      shell.records.put(x.info, x.seq);
      info = x.info;
      base = { ...base, version: x.info.version };
      if (shell.router.current.peek().params.id === id) {
        titleInput.value = to;
        ctx.setTitle(to);
      }
      return x.info.version;
    };
    const rename = async () => {
      const title = titleInput.value.replace(/\s+/g, " ").trim();
      if (!title || title === info.title) {
        titleInput.value = info.title;
        return;
      }
      await save();
      const before = info.title;
      try {
        await retitle(title, info.version);
        // Each expects the version this page last saved or renamed to: the board's own saves
        // don't stop it; a change from elsewhere does.
        shell.undo.done(`Renamed to “${title}”`, {
          label: `rename to “${title}”`,
          undo: async () => (await save(), void (await retitle(before, base.version))),
          redo: async () => (await save(), void (await retitle(title, base.version))),
        }, { scope });
      } catch (e) {
        titleInput.value = info.title;
        toast(message(e));
      }
    };
    titleInput.addEventListener("keydown", (e) => {
      if (e.isComposing) return;
      if (e.key === "Enter" || e.key === "Escape") {
        e.preventDefault();
        if (e.key === "Escape") titleInput.value = info.title;
        titleInput.blur();
      }
    });
    titleInput.addEventListener("blur", () => void rename());
    ctx.setHeaderActions([
      h("button", { class: "icon-button", "aria-label": "Move to folder", title: "Move to folder", onclick: () => { const r = shell.records.get(id); if (r) void save().then(() => shell.undo.within(scope, () => shell.folders.moveTo([r]))); } }, icon(FolderInput)),
    ]);
    if (params.focus === "title") {
      titleInput.focus();
      titleInput.select();
    }
  })();

  return () => {
    alive = false;
    for (const c of cleanup.splice(0)) c();
  };
}
