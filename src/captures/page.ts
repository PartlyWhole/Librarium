/**
 * A capture's page: the archived notice, its name, the quotation (each part with Show, and a
 * badge when it moved or was lost, with "This is the place" for a moved one), the citation,
 * your words (an autosaved editor, as in notes), and where it is used. The header offers Show in
 * the source, Edit selection, Copy embed, Export as W3C annotations and Delete. Deleting keeps
 * the page, now saying it is in the archive; ⌘Z there restores it.
 */
import type { EditorView } from "@codemirror/view";
import { call, pickSavePath } from "../backend";
import type { PageContext, PageHandle } from "../app/pages";
import { beforeQuit } from "../app/quit";
import { getRecord, isArchived, openRecord, putRecord, records } from "../app/records";
import { showStatus } from "../app/status";
import { attachEditor, done, keepText, recordScope, takeText, typed } from "../app/undo";
import { errorText, h, replace } from "../ui/dom";
import { iconButton } from "../ui/icon";
import { effect, untracked } from "../ui/signal";
import { toast } from "../ui/toast";
import type { RecordInfo, RecordText, Written } from "../types";
import { createEditor, historyJSON, replaceDoc, textHistory } from "../notes/editor/editor";
import { NoteSession } from "../notes/editor/session";
import { describe, flowQuote, locate, toW3C, type Anchor } from "./anchor";
import { anchorOf, badge, citation, copyEmbed, isRegion, partQuote, placeParams, quoteParts, regionImage, showInSource, sourceOf, statuses, storedText, type ShownPart } from "./common";
import { deleteCapture } from "./delete";
import { findReferences, type Reference } from "./references";
import { Copy, FileDown, LocateFixed, Pencil, Trash2 } from "lucide";

export function renderCapture(host: HTMLElement, params: Record<string, string>, ctx: PageContext): PageHandle {
  const id = params.id ?? "";
  let alive = true;
  let cleanup: (() => void)[] = [];
  let drawn = 0;
  // Drawn again in place when the capture is deleted or restored, or a moved part confirmed.
  const redraw = () => {
    cleanup.forEach((c) => c());
    cleanup = [];
    void draw();
  };
  const draw = async () => {
    const me = ++drawn;
    const live = () => alive && me === drawn;
    const t = await call<RecordText>("records.read", { id }).catch(() => null);
    if (!live()) return;
    if (!t) return replace(host, h("p", { class: "empty" }, "This capture can’t be found any more."));
    const anchor = await anchorOf(id).catch(() => null);
    const st = anchor ? await statuses(anchor) : [];
    if (live()) cleanup = mount(host, ctx, t, anchor, st, () => live() && redraw());
  };
  void draw();
  return () => {
    alive = false;
    cleanup.forEach((c) => c());
  };
}

function mount(host: HTMLElement, ctx: PageContext, t: RecordText, anchor: Anchor | null, st: string[], redraw: () => void): (() => void)[] {
  const id = t.info.id;
  const scope = recordScope(id);
  const cleanup: (() => void)[] = [];
  let info = t.info;
  const src = sourceOf(info);
  ctx.setTitle(info.title || "Capture");

  // ---- The quotation ----
  const many = (anchor?.parts.length ?? 0) > 1;
  const shown = (anchor?.parts ?? []).map((p, i): ShownPart => {
    const status = st[i] === "moved" || st[i] === "lost" ? st[i] : "";
    const confirm = status === "moved" ? h("button", { class: "link-button", onclick: () => void confirmMoved(anchor!, i).then(redraw) }, "This is the place") : null;
    const show = many ? iconButton(LocateFixed, `Show part ${i + 1} in the source`, () => openRecord(src, placeParams(anchor, p), { again: true }), undefined, 15) : null;
    const tools = show || status ? h("span", { class: `capture-tools ${isRegion(p) ? "row tight" : "inline-tools"}` }, show, badge(status), confirm) : null;
    return isRegion(p) ? { picture: h("div", { class: "capture-part" }, regionImage(id, i + 1), tools) } : { text: flowQuote(partQuote(p)), after: tools };
  });
  const cite = h("p", { class: "capture-cite muted" }, "— ", h("a", { href: "#", class: "list-link", onclick: (e: MouseEvent) => (e.preventDefault(), openRecord(src, placeParams(anchor), { again: true, newTab: e.metaKey })) }, citation(info)));

  // ---- The name: renaming is a step of this page's undo ----
  const titleInput = h("input", { class: "title-input", value: info.title, "aria-label": "Title", spellcheck: true, placeholder: "Capture" });
  const retitle = async (title: string, base?: string) => {
    const w = await call<Written>("records.relocate", { id, title, ...(base ? { base_version: base } : {}) });
    putRecord(w.info);
    info = w.info;
    session.rebase(w.info.version, session.savedBody);
    if (document.activeElement !== titleInput) titleInput.value = title;
    ctx.setTitle(title);
    return w.info.version;
  };
  const rename = async () => {
    const title = titleInput.value.replace(/\s+/g, " ").trim();
    const before = info.title;
    if (!title || title === before) return void (titleInput.value = before);
    try {
      let version = await retitle(title);
      done(`Renamed to “${title}”`, {
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
    if (e.key === "Enter" || e.key === "Escape") {
      e.preventDefault();
      if (e.key === "Escape") titleInput.value = info.title;
      view.focus();
    }
  });
  titleInput.addEventListener("blur", () => void rename());

  // ---- Your words ----
  const editorHost = h("div", { class: "editor-host capture-words" });
  const usedIn = h("section", { class: "used-in", "aria-label": "Used in" });
  const archived = isArchived(info) ? h("p", { class: "notice" }, "This capture is in the archive. ", h("button", { type: "button", class: "link-button", onclick: () => void restore(info) }, "Restore")) : null;
  replace(host, archived, titleInput, h("div", null, quoteParts(shown, "capture-quote")), cite, h("h2", { class: "list-heading" }, "Your words"), editorHost, usedIn);

  const session: NoteSession = new NoteSession(id, info.version, t.body, {
    current: () => view.state.doc.toString(),
    replace: (body) => replaceDoc(view, body),
    conflict: async () => null,
    status: (text, persistent) => showStatus(text, persistent ? 0 : 4000),
  });
  const view: EditorView = createEditor({
    parent: editorHost,
    doc: t.body,
    history: takeText(scope, t.body) ?? undefined,
    onHistoryStep: () => typed(scope),
    readOnly: !!info.read_only,
    label: "Your words",
    // Your words are plain words: no link completion.
    targets: () => [],
    open: (target, o) => openRecord(target, {}, o),
    titleOf: (target) => untracked(() => getRecord(target))?.title ?? null,
    onChange: () => session.changed(),
    onBlur: () => void session.flush(),
    placeholder: "Write why this matters…",
  });
  const detach = attachEditor(view.dom, scope, textHistory(view));
  const unquit = beforeQuit(() => session.close());
  cleanup.push(() => {
    keepText(scope, historyJSON(view), view.state.doc.toString());
    detach();
    unquit();
    void session.close();
    view.destroy();
  });

  // Deleted or restored (here, by Undo, or elsewhere): the page shows it.
  let wasArchived = isArchived(info);
  cleanup.push(effect(() => {
    const now = isArchived(records().get(id));
    if (now === wasArchived) return;
    wasArchived = now;
    queueMicrotask(redraw);
  }));

  void findReferences(id).then((refs) => usedIn.isConnected && showUsedIn(usedIn, refs));

  ctx.setHeaderActions([
    iconButton(LocateFixed, "Show in the source", () => showInSource(info)),
    iconButton(Pencil, "Edit selection", () => showInSource(info, { edit: true }), undefined, undefined, "Edit what this capture holds, in its source (drag a passage’s ends, resize a region)"),
    iconButton(Copy, "Copy embed", () => copyEmbed(info), undefined, undefined, "Copy embed (paste it into a note)"),
    iconButton(FileDown, "Export as W3C annotations", () => void exportW3C(info, view.state.doc.toString())),
    isArchived(info) ? null : iconButton(Trash2, "Delete capture", async () => {
      await session.flush();
      await deleteCapture(getRecord(id) ?? info, scope);
    }, undefined, undefined, "Delete (it goes to the archive, where you can restore it or delete it for good)"),
  ].filter((b) => !!b));
  return cleanup;
}

/** Each note that uses the capture, and each place in it ("After “…”"); a click goes there. */
function showUsedIn(host: HTMLElement, refs: Reference[]): void {
  const sources = [...new Map(refs.map((x) => [x.source.id, x.source])).values()];
  const go = (sid: string, params: Record<string, string>) => (e: MouseEvent) => (e.preventDefault(), openRecord(sid, params, { newTab: e.metaKey }));
  const short = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
  replace(host,
    h("h2", { class: "list-heading" }, "Used in", refs.length ? h("span", { class: "muted small" }, ` ${sources.length}`) : null),
    refs.length
      ? h("ul", { class: "backlinks used-in-list" }, sources.map((s) => h("li", null,
          h("a", { href: "#", class: "list-link", onclick: go(s.id, {}) }, s.title || "Untitled"),
          refs.filter((x) => x.source.id === s.id).map((x) => {
            // Just before the place (the line above), so a placed quotation shows as itself.
            const at = [...x.body.slice(0, Math.max(0, x.body.lastIndexOf("\n", x.link.from - 1)))].length;
            const words = x.link.embed ? (x.before ? `After “${short(x.before, 80)}”` : "At the start") : short(x.line, 100);
            return h("a", { href: "#", class: "used-in-place muted small", title: "Go to this place", onclick: go(s.id, { at: String(at) }) }, words);
          }))))
      : h("p", { class: "muted small" }, "Not used in any note yet. Copy its embed and paste it into a note to place it there."));
}

/** Restores an archived capture from its page (undoable there). */
async function restore(c: RecordInfo): Promise<void> {
  const step = async (method: string) => {
    const w = await call<Written>(method, { id: c.id });
    putRecord(w.info);
  };
  try {
    await step("archive.restore");
    const what = `“${c.title || "Capture"}”`;
    done(`Restored ${what}`, { label: `restore ${what}`, undo: () => step("archive.archive"), redo: () => step("archive.restore") }, recordScope(c.id));
  } catch (e) {
    toast(errorText(e));
  }
}

/** The user confirms a moved part's new place: the anchor now points there. */
async function confirmMoved(a: Anchor, i: number): Promise<void> {
  const stored = await storedText(a);
  const loc = stored && locate(stored.text, a.parts[i]!.selector);
  if (!stored || loc?.start === undefined) return;
  const [quote, pos] = describe(stored.text, loc.start, loc.end!);
  const parts = a.parts.map((p, k) => (k !== i ? p : { ...p, selector: [quote, pos, ...p.selector.filter((s) => s.type !== "TextQuoteSelector" && s.type !== "TextPositionSelector")] }));
  try {
    await call("captures.updateAnchor", { id: a.id, parts });
    toast("The capture now points to its new place.");
  } catch (e) {
    toast(errorText(e));
  }
}

async function exportW3C(c: RecordInfo, words: string): Promise<void> {
  try {
    const a = await anchorOf(c.id);
    const path = await pickSavePath(`${c.title || "capture"}.jsonld`, "Export as W3C annotations");
    if (!path) return;
    const json = JSON.stringify(toW3C(a, words.trim(), `urn:uuid:${a.source}`, c.created ?? new Date().toISOString()), null, 2);
    await call("export.write", { path, text: json, data: null });
    showStatus("Exported.");
  } catch (e) {
    toast(errorText(e));
  }
}
