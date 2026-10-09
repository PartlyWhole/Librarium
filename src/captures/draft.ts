/**
 * Making and editing captures in the reader. A selection gets a button by it (Capture, or Add
 * to capture); each choice adds a part to the capture being made, the draft, which waits at the
 * top of the side panel's Captures view with its parts highlighted in place until it is saved.
 * There is one draft per source and snapshot, and it survives leaving the item and coming back.
 * Saved captures are drawn softly in the document; a click on one offers Open, Edit and Delete.
 * Editing a saved capture's parts (`?edit=<id>` on the source) loads them into the draft, with
 * handles and frames in the document and a bar over it.
 */
import { call } from "../backend";
import { showPanelView } from "../app/panel";
import { getRecord, openRecord, putRecord } from "../app/records";
import { router } from "../app/router";
import { showStatus } from "../app/status";
import { recordScope } from "../app/undo";
import { errorText, h, replace } from "../ui/dom";
import { icon, iconButton } from "../ui/icon";
import { effect, signal, untracked } from "../ui/signal";
import { toast } from "../ui/toast";
import type { CapturePart, SavedMarks, StoredText, Written } from "../types";
import { onReaderOpen, type Box, type EditedPart, type EditPart, type OpenReader, type PartsEditor, type ReaderRegion, type ReaderSelection } from "../reader";
import { CFI, describe, flowQuote, locateSelection, MEDIA, PDF_PAGE, sliceCp, type Selector } from "./anchor";
import { anchorOf, capturesOf, cite, isRegion, partQuote, placeParams, quoteParts, type ShownPart } from "./common";
import { deleteCapture } from "./delete";
import { Crop, Highlighter, Pencil, Quote, Trash2, X } from "lucide";

/** A part of the capture being made. */
export interface DraftPart extends CapturePart {
  key: string;
  /** A region's picture, shown while the capture is made. */
  preview?: string;
  /** Where it is in the source (page, top, offset), so parts read in the source's order. */
  order: number[];
  region?: boolean;
  cfi?: string;
}

export interface Draft {
  parts: DraftPart[];
  words: string;
  /** Editing a saved capture's parts (not making a new one); its name may change too. */
  editing?: { id: string; title: string; original: string };
}

/** The drafts, by source and snapshot (`draftKey`). */
export const drafts = signal<Map<string, Draft>>(new Map());
export const draftKey = (source: string, snapshot?: string | null) => `${source}|${snapshot ?? ""}`;

export function setDraft(k: string, d: Draft | null): void {
  const m = new Map(drafts.peek());
  if (d && (d.parts.length || d.words || d.editing)) m.set(k, d);
  else m.delete(k);
  drafts.set(m);
}

/** The draft's element for the side panel, with the source it belongs to. */
export const draftShown = signal<{ source: string; el: HTMLElement } | null>(null);

/** What each open reader can do, by draft key. */
interface Controller {
  addSelection(): Promise<void>;
  addRegion(): Promise<void>;
  save(): Promise<void>;
}
const controllers = new Map<string, Controller>();
/** The reader shown's controller, if any. */
export function controllerFor(r: OpenReader | null): Controller | undefined {
  return r ? controllers.get(draftKey(r.source.id, r.snapshot)) : undefined;
}
/** Saves the draft of `k` (Save changes in the panel's row). */
export const saveDraft = (k: string) => void controllers.get(k)?.save();

let n = 0;
const PNG = /^data:image\/png;base64,/;

const byOrder = (a: DraftPart, b: DraftPart) => {
  for (let i = 0; i < Math.max(a.order.length, b.order.length); i++) {
    const d = (a.order[i] ?? 0) - (b.order[i] ?? 0);
    if (d) return d;
  }
  return 0;
};

const toPart = ({ selector, quote, locator, region_png, boxes }: DraftPart): CapturePart => ({ selector, quote, locator, region_png, boxes });

/** A part from a selection (text, or a picture on its own), anchored in the stored text. */
function partFromSelection(sel: ReaderSelection, st: StoredText | null, key = `p${++n}`): { part: DraftPart; found: boolean } {
  if (sel.image && !sel.text) {
    const selector: Selector[] = sel.cfi ? [{ type: "FragmentSelector", value: sel.cfi, conformsTo: CFI }] : [];
    const seg = sel.chapter !== undefined ? st?.segments[sel.chapter] : undefined;
    return { found: true, part: { key, selector, quote: "", locator: seg?.label || null, region_png: sel.image.replace(PNG, ""), preview: sel.image, order: [sel.chapter ?? 0, 0, 0], boxes: [], region: true, cfi: sel.cfi } };
  }
  const seg = st && (sel.page ? st.segments[sel.page - 1] : sel.chapter !== undefined ? st.segments[sel.chapter] : undefined);
  const at = st ? locateSelection(st.text, sel.text, seg ? { from: seg.start, to: seg.end } : undefined) : null;
  // Not in the stored text: kept with its page only (no context, no position).
  const selector: Selector[] = at && st ? [...describe(st.text, at.start, at.end)] : [{ type: "TextQuoteSelector", exact: sel.text, prefix: "", suffix: "" }];
  if (sel.page) selector.push({ type: "FragmentSelector", value: `page=${sel.page}`, conformsTo: PDF_PAGE });
  if (sel.cfi) selector.push({ type: "FragmentSelector", value: sel.cfi, conformsTo: CFI });
  const first = sel.boxes?.[0];
  return {
    found: !!at,
    part: {
      key,
      selector,
      quote: flowQuote(at && st ? sliceCp(st.text, at.start, at.end) : sel.text),
      locator: seg?.label || (sel.page ? `p. ${sel.page}` : null),
      region_png: null,
      order: [first?.page ?? sel.page ?? sel.chapter ?? 0, first?.y ?? 0, at?.start ?? 0],
      boxes: sel.boxes ?? [],
      cfi: sel.cfi,
    },
  };
}

/** A region part (dragged out, or edited). */
function partFromRegion(r: ReaderRegion, key = `p${++n}`): DraftPart {
  const xywh = { type: "FragmentSelector" as const, value: `xywh=percent:${r.x},${r.y},${r.w},${r.h}`, conformsTo: MEDIA };
  const selector: Selector[] = r.page ? [{ type: "FragmentSelector", value: `page=${r.page}`, conformsTo: PDF_PAGE, refinedBy: xywh }] : [xywh];
  const box: Box = { ...(r.page ? { page: r.page } : {}), x: r.x, y: r.y, w: r.w, h: r.h };
  return { key, selector, quote: "", locator: r.page ? `p. ${r.page}` : null, region_png: r.png.replace(PNG, ""), preview: r.png, order: [r.page ?? 0, r.y, 0], boxes: [box], region: true };
}

/** A saved capture's parts, loaded into a draft to edit them. */
async function partsOf(id: string): Promise<DraftPart[] | null> {
  const a = await anchorOf(id).catch(() => null);
  if (!a) return null;
  const locator = (getRecord(id)?.fields["captures.locator"] as string | undefined) ?? null;
  const parts: DraftPart[] = [];
  for (const [i, p] of a.parts.entries()) {
    const frag = (prefix: string) => p.selector.flatMap((x) => ("value" in x ? [x.value, x.refinedBy?.value] : [])).find((v) => v?.startsWith(prefix));
    const page = Number(frag("page=")?.slice(5)) || undefined;
    const xywh = frag("xywh=percent:")?.slice(13).split(",").map(Number);
    const region = isRegion(p) || !!xywh;
    const png = region ? await call<string>("captures.region", { id, n: i + 1 }).catch(() => "") : "";
    parts.push({
      key: `p${++n}`,
      selector: p.selector,
      quote: flowQuote(partQuote(p)),
      locator: page ? `p. ${page}` : locator,
      region_png: png ? png.replace(PNG, "") : null,
      preview: png || undefined,
      order: [page ?? 0, p.boxes?.[0]?.y ?? xywh?.[1] ?? 0, i],
      boxes: p.boxes ?? (xywh ? [{ ...(page ? { page } : {}), x: xywh[0]!, y: xywh[1]!, w: xywh[2]!, h: xywh[3]! }] : []),
      region,
      cfi: frag("epubcfi("),
    });
  }
  return parts;
}

function toEdit(p: DraftPart): EditPart {
  const b = p.region && !p.cfi ? p.boxes[0] : undefined;
  return { key: p.key, ...(b ? { region: { ...(b.page ? { page: b.page } : {}), x: b.x, y: b.y, w: b.w, h: b.h } } : {}), boxes: p.boxes, cfi: p.cfi ?? null, page: p.boxes[0]?.page, quote: p.quote };
}

/** A small inverted pop-up by a selection or a mark. */
function popup(label: string): HTMLElement {
  const el = h("div", { class: "selection-pop", role: "toolbar", "aria-label": label, hidden: true });
  document.body.appendChild(el);
  return el;
}

const popButton = (node: Parameters<typeof icon>[0], label: string, run: () => void, title?: string) =>
  h("button", { type: "button", title, onmousedown: (e: Event) => e.preventDefault(), onclick: run }, icon(node, 14), label);

function place(el: HTMLElement, x: number, below: number, above: number): void {
  const w = el.offsetWidth || 140;
  Object.assign(el.style, { left: `${Math.max(8, Math.min(window.innerWidth - w - 8, x - w / 2))}px`, top: `${below + 36 > window.innerHeight ? above : below}px` });
}

onReaderOpen((r) => {
  const { view, source } = r;
  const k = draftKey(source.id, r.snapshot);
  const cleanup: (() => void)[] = [];
  const draft = () => drafts.peek().get(k);
  const add = (p: DraftPart) => {
    const d = draft() ?? { parts: [], words: "" };
    setDraft(k, { ...d, parts: [...d.parts, p].sort(byOrder) });
  };

  const addSelection = async () => {
    const sel = view.selection?.();
    if (!sel) return showStatus("Select some text first.");
    pop.hidden = true;
    const { part, found } = partFromSelection(sel, await r.text());
    add(part);
    view.clearSelection?.();
    if (!found) showStatus("The stored text doesn’t contain that passage exactly, so it was kept with its page only.", 6000);
  };
  const addRegion = async () => {
    if (!view.pickRegion) return showStatus("Regions can’t be captured in this kind of item.");
    pop.hidden = true;
    const region = await view.pickRegion();
    if (region) add(partFromRegion(region));
  };
  const save = async () => {
    const d = draft();
    if (!d?.parts.length) return;
    try {
      if (d.editing) {
        let w = await call<Written>("captures.update", { id: d.editing.id, parts: d.parts.map(toPart) });
        const title = d.editing.title.replace(/\s+/g, " ").trim();
        if (title && title !== d.editing.original && title !== w.info.title) w = await call<Written>("records.relocate", { id: d.editing.id, title });
        putRecord(w.info);
        setDraft(k, null);
        toast("Capture updated.", { action: { label: "Open", run: () => openRecord(w.info.id) } });
      } else {
        const st = await r.text();
        const w = await call<Written>("captures.create", { source: source.id, snapshot: r.snapshot ?? null, text: st?.origin ?? null, parts: d.parts.map(toPart), words: d.words });
        putRecord(w.info);
        setDraft(k, null);
        toast("Captured.", { action: { label: "Open", run: () => openRecord(w.info.id) } });
      }
    } catch (e) {
      toast(errorText(e));
    }
  };
  controllers.set(k, { addSelection, addRegion, save });
  cleanup.push(() => controllers.delete(k));

  // ---- The button by a selection ----
  const pop = popup("Selection");
  const showPop = () => {
    const sel = view.selection?.();
    if (!sel?.end) return void (pop.hidden = true);
    const image = !!sel.image && !sel.text;
    const adding = !!draft()?.parts.length;
    replace(pop, popButton(Highlighter, adding ? (image ? "Add image to capture" : "Add to capture") : image ? "Capture image" : "Capture", () => void addSelection()));
    pop.hidden = false;
    place(pop, sel.end.x, sel.end.bottom + 8, sel.end.y - 40);
  };
  cleanup.push(view.watchSelection?.(showPop) ?? (() => {}), () => pop.remove());

  // ---- Saved captures, drawn softly; a click on one offers Open, Edit and Delete ----
  const saved = signal<SavedMarks[]>([]);
  let asked = 0;
  let lastSig = "";
  cleanup.push(effect(() => {
    const mine = capturesOf(source.id);
    // Asked again only when this source's captures change.
    const sig = mine.map((c) => `${c.id}:${c.version}`).join();
    if (sig === lastSig) return;
    lastSig = sig;
    const visible = new Set(mine.map((c) => c.id));
    const ask = ++asked;
    if (!mine.length) return saved.set([]);
    void call<SavedMarks[]>("captures.forSource", { source: source.id, snapshot: r.snapshot ?? null }).then((list) => ask === asked && saved.set(list.filter((c) => visible.has(c.id))), () => {});
  }));

  const markPop = popup("Capture");
  cleanup.push(view.onMarkClick?.((ids, at) => {
    const caps = [...new Set(ids.map((id) => id.split("#")[0]!))].map((id) => saved.peek().find((c) => c.id === id)).filter((c) => !!c);
    if (!caps.length) return;
    pop.hidden = true;
    const one = caps.length === 1 ? getRecord(caps[0]!.id) : undefined;
    const close = (run: () => void) => () => ((markPop.hidden = true), run());
    replace(markPop,
      caps.map((c) => popButton(Quote, caps.length > 1 ? `Open “${c.title.length > 28 ? `${c.title.slice(0, 28)}…` : c.title}”` : "Open capture", close(() => openRecord(c.id)), c.title)),
      one && view.editParts ? popButton(Pencil, "Edit", close(() => void startEdit(one.id)), "Edit what this capture holds") : null,
      one ? popButton(Trash2, "Delete", close(() => void deleteCapture(one, recordScope(source.id))), "Delete this capture (it goes to the archive)") : null);
    markPop.hidden = false;
    place(markPop, at.x, at.y + 12, at.y - 44);
  }) ?? (() => {}), () => markPop.remove());

  const onAway = (e: MouseEvent) => !markPop.hidden && !markPop.contains(e.target as Node) && (markPop.hidden = true);
  const onScroll = () => ((pop.hidden = true), (markPop.hidden = true));
  const onKey = (e: KeyboardEvent) => e.key === "Escape" && onScroll();
  window.addEventListener("mousedown", onAway, true);
  document.addEventListener("scroll", onScroll, true);
  window.addEventListener("keydown", onKey);
  cleanup.push(() => {
    window.removeEventListener("mousedown", onAway, true);
    document.removeEventListener("scroll", onScroll, true);
    window.removeEventListener("keydown", onKey);
  });

  // ---- Editing a saved capture's parts ----
  const startEdit = async (id: string) => {
    if (!view.editParts) return showStatus("Captures can’t be edited in this kind of item.");
    const cur = draft();
    if (cur?.editing?.id === id) return;
    if (cur?.parts.length && !cur.editing) return showStatus("Save or discard the capture being made first.", 5000);
    const c = getRecord(id);
    const parts = c && (await partsOf(id));
    if (!c || !parts) return showStatus("This capture can’t be found.");
    setDraft(k, { parts, words: "", editing: { id, title: c.title || "Capture", original: c.title || "Capture" } });
    showPanelView("captures");
    const a = await anchorOf(id).catch(() => null);
    if (a?.parts[0]) void view.showPlace?.(JSON.parse(placeParams(a).place ?? "[]"));
  };
  // A part dragged: redrawn as it moves; anchored again (quote, selectors) when let go.
  const edited = async (e: EditedPart) => {
    const old = draft()?.parts.find((x) => x.key === e.key);
    if (!old) return;
    let next = old;
    if (e.text) next = e.done ? partFromSelection(e.text, await r.text(), e.key).part : { ...old, boxes: e.text.boxes ?? old.boxes, cfi: e.text.cfi ?? old.cfi, quote: e.text.text };
    else if (e.region) {
      const { page, x, y, w, h: hh, png } = e.region;
      next = e.done && png ? partFromRegion({ page, x, y, w, h: hh, png }, e.key) : { ...old, boxes: [{ ...(page ? { page } : {}), x, y, w, h: hh }] };
    }
    const cur = draft();
    if (cur) setDraft(k, { ...cur, parts: cur.parts.map((x) => (x.key === e.key ? next : x)).sort(byOrder) });
  };
  // The parts editor follows the draft: given new parts when one is added or removed (not on
  // every drag, which would take the handle away mid-drag), stopped after.
  let editor: PartsEditor | null = null;
  let editorKeys = "";
  cleanup.push(effect(() => {
    const d = drafts().get(k);
    untracked(() => {
      if (!d?.editing || !view.editParts) {
        editor?.stop();
        editor = null;
        editorKeys = "";
        return;
      }
      const keys = d.parts.map((p) => p.key).join();
      if (!editor) editor = view.editParts(d.parts.map(toEdit), (e) => void edited(e));
      else if (keys !== editorKeys) editor.update(d.parts.map(toEdit));
      editorKeys = keys;
    });
  }), () => editor?.stop());
  // Asked for by the route: Edit selection, from a capture's page or list.
  let lastRoute: unknown = null;
  cleanup.push(effect(() => {
    const route = router.current();
    if (route === lastRoute) return;
    lastRoute = route;
    if (route.page === "item" && route.params.id === source.id && route.params.edit) untracked(() => void startEdit(route.params.edit!));
  }));

  // ---- The draft in the side panel, the marks, the edit bar ----
  const panel = h("section", { class: "capture-draft", "aria-label": "New capture" });
  const editBar = h("div", { class: "capture-edit-bar", role: "toolbar", "aria-label": "Editing a capture" });
  const hidePanel = () => {
    panel.remove();
    if (draftShown.peek()?.el === panel) draftShown.set(null);
  };
  cleanup.push(effect(() => {
    const d = drafts().get(k);
    const savedMarks = saved().filter((c) => c.id !== d?.editing?.id).flatMap((c) => c.parts.map((p, i) => ({ id: `${c.id}#${i}`, boxes: p.boxes, region: p.region, cfi: p.region ? undefined : (p.cfi ?? undefined), saved: true })));
    view.setMarks?.([...savedMarks, ...(d?.parts ?? []).map((p) => ({ id: p.key, boxes: p.boxes, region: p.region, cfi: p.region ? undefined : p.cfi }))]);
    if (d?.editing) {
      hidePanel();
      return untracked(() => renderEditBar(d));
    }
    editBar.remove();
    if (!d?.parts.length) return hidePanel();
    untracked(() => renderPanel(d));
    if (draftShown.peek()?.el !== panel) {
      draftShown.set({ source: source.id, el: panel });
      if (untracked(router.current).page === "item") showPanelView("captures");
    }
  }), () => (editBar.remove(), hidePanel()));

  function renderEditBar(d: Draft) {
    replace(editBar,
      h("span", { class: "edit-bar-title" }, `Editing “${d.editing!.title}”`, h("span", { class: "muted" }, ` · ${d.parts.length === 1 ? "1 part" : `${d.parts.length} parts`}`)),
      h("button", { class: "button", type: "button", onclick: () => setDraft(k, null) }, "Cancel"),
      h("button", { class: "button primary", type: "button", title: "Save changes (⌘↩)", disabled: !d.parts.length, onclick: () => void save() }, "Save changes"));
    if (!editBar.isConnected) r.body.appendChild(editBar);
  }

  function renderPanel(d: Draft) {
    const remove = (p: DraftPart, size = 12) => h("button", { class: "icon-button inline-remove", type: "button", "aria-label": "Remove this part", title: "Remove this part", onclick: () => setDraft(k, { ...d, parts: d.parts.filter((x) => x !== p) }) }, icon(X, size));
    const parts = quoteParts(d.parts.map((p): ShownPart => (p.preview
      ? { picture: h("div", { class: "draft-picture" }, h("img", { class: "capture-region", src: p.preview, alt: "The captured picture" }), remove(p)) }
      : { text: p.quote, after: remove(p) })), "capture-quote");
    const words = h("textarea", { class: "words-input", rows: 3, placeholder: "Your words (optional)", "aria-label": "Your words" });
    words.value = d.words;
    // Kept in the draft without drawing the panel again (which would take the focus away).
    words.addEventListener("input", () => {
      const cur = draft();
      if (cur) drafts.peek().set(k, { ...cur, words: words.value });
    });
    const hadFocus = document.activeElement?.classList.contains("words-input") && panel.contains(document.activeElement);
    replace(panel,
      h("h3", { class: "capture-draft-head" }, d.parts.length > 1 ? `New capture · ${d.parts.length} parts` : "New capture"),
      h("div", { class: "draft-part" }, parts),
      h("p", { class: "draft-hint" }, view.pickRegion ? "Select more text, or drag a region (⇧⌘R), to add to it." : "Select more text to add to it."),
      h("p", { class: "muted small" }, `From ${cite(source.title, d.parts.map((p) => p.locator))}`),
      words,
      h("div", { class: "ask-buttons" },
        h("button", { class: "button", type: "button", onclick: () => setDraft(k, null) }, "Discard"),
        h("button", { class: "button primary", type: "button", title: "Save capture (⌘↩)", onclick: () => void save() }, "Save capture")));
    if (hadFocus) words.focus();
  }

  // ---- The toolbar's buttons ----
  const buttons = [iconButton(Highlighter, "Capture the selection", () => void addSelection(), "Mod+Shift+C"), view.pickRegion ? iconButton(Crop, "Capture a region", () => void addRegion(), "Mod+Shift+R") : null].filter((b) => !!b);
  r.tools.append(...buttons);
  cleanup.push(() => buttons.forEach((b) => b.remove()));

  return () => cleanup.forEach((c) => c());
});
