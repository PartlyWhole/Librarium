/**
 * Captures: select a passage (or a region, in one part or several) and keep it with your own
 * words. A capture always points back to its exact place; placed in writing as
 * `![[label|id]]`, it shows as the quotation with its citation.
 */
import { call } from "../../backend";
import { h, replace } from "../../kit/dom";
import { icon } from "../../kit/icon";
import { signal, effect, untracked } from "../../kit/signal";
import { toast } from "../../kit/toast";
import { describe, locate, locateSelection, sliceCp, toW3C, type Selector } from "../../kit/anchor";
import { createEditor } from "../../editor/editor";
import { NoteSession } from "../../editor/session";
import type { ShellApi } from "../../shell/api";
import { ITEM_CHILDREN, READER_TOOLS, type ItemChildren, type ReaderTool } from "../../shell/slots";
import type { CapturePart } from "../../generated/CapturePart";
import type { RecordInfo } from "../../generated/RecordInfo";
import type { RecordText } from "../../generated/RecordText";
import type { StoredText } from "../../generated/StoredText";
import type { Written } from "../../generated/Written";
import { embedExtension } from "./embeds";
import { Highlighter, Crop, Quote, FileDown, X, Trash2, Copy, LocateFixed, Pencil } from "lucide";
import { contextMenu } from "../../kit/menu";
import { flowQuote } from "../../kit/flow";
import type { Box, EditedPart, EditPart, PartsEditor, ReaderSelection } from "../../reader/host";

export const KIND = "capture";
const F = { source: "captures.source", quote: "captures.quote", locator: "captures.locator" };
const PDF_PAGE = "http://tools.ietf.org/rfc/rfc8118";
const MEDIA = "http://www.w3.org/TR/media-frags/";
const CFI = "http://www.idpf.org/epub/linking/cfi/epub-cfi.html";
/** A small icon button with its name as a tooltip (and for assistive technology). */
function iconButton(node: Parameters<typeof icon>[0], label: string, run: () => void, destructive = false): HTMLButtonElement {
  return h("button", { type: "button", class: `icon-button small${destructive ? " destructive" : ""}`, title: label, "aria-label": label, onclick: run }, icon(node, 15));
}
/** Archived records carry this field (set by the archive feature). */
const ARCHIVED = "archive.at";
const isArchived = (r: RecordInfo | undefined) => r?.fields[ARCHIVED] != null;

/** A part of the capture being made. */
interface DraftPart extends CapturePart {
  key: string;
  /** A region's picture, to show while making the capture. */
  preview?: string;
  /** Where it is in the source (page, top, offset), so parts read in the source's order. */
  order: number[];
  /** Where to highlight it while the capture is being made. */
  boxes: Box[];
  region?: boolean;
  cfi?: string;
}

interface Draft {
  parts: DraftPart[];
  words: string;
  /** Editing a saved capture's parts (instead of making a new capture); `title` may be renamed. */
  editing?: { id: string; title: string; original: string };
}

const byOrder = (a: DraftPart, b: DraftPart) => {
  for (let i = 0; i < Math.max(a.order.length, b.order.length); i++) {
    const d = (a.order[i] ?? 0) - (b.order[i] ?? 0);
    if (d) return d;
  }
  return 0;
};

const toPart = ({ selector, quote, locator, region_png, boxes }: DraftPart): CapturePart => ({ selector, quote, locator, region_png, boxes });

/** A saved capture of a source, with where to highlight each part (captures.forSource). */
interface SavedMarks {
  id: string;
  title: string;
  parts: { boxes: Box[]; cfi: string | null; region: boolean }[];
}

interface Anchor {
  id: string;
  source: string;
  snapshot?: string | null;
  parts: { selector: Selector[]; region?: string; boxes?: Box[] }[];
}

export type PartStatus = { status: "found" | "moved" | "lost" | "region"; start?: number; end?: number };

/** Locates every part of a capture in its source's stored text. */
export async function statuses(anchor: Anchor): Promise<PartStatus[]> {
  const stored = await call<StoredText | null>("records.text", { id: anchor.source, part: anchor.snapshot ?? undefined }).catch(() => null);
  return anchor.parts.map((p) => {
    const hasQuote = p.selector.some((s) => s.type === "TextQuoteSelector" && s.exact);
    if (!hasQuote) return { status: "region" };
    if (!stored) return { status: "lost" };
    return locate(stored.text, p.selector) as PartStatus;
  });
}

export function citation(shell: ShellApi, r: RecordInfo): string {
  const src = shell.records.get(String(r.fields[F.source] ?? ""));
  const loc = r.fields[F.locator] ? `, ${r.fields[F.locator]}` : "";
  return `${src?.title ?? "an unknown source"}${loc}`;
}

export function captures(shell: ShellApi): void {
  shell.openers.add("captures", KIND, "capture");
  /**
   * Deleting a capture moves it to the archive (with Undo), the first of the library's two steps;
   * it is deleted for good from there. Done through the archive's own record action.
   */
  const deleteCapture = async (c: RecordInfo): Promise<boolean> => {
    const archive = shell.recordActions.get("archive");
    if (!archive || !archive.applies(c)) {
      shell.status.show("This capture can’t be deleted here.");
      return false;
    }
    await archive.run([c]);
    return true;
  };
  const captureMenu = (c: RecordInfo, at: { x: number; y: number }) =>
    contextMenu([
      { label: "Open", run: () => shell.openRecord(c.id) },
      { label: "Show in the source", run: () => void call<Anchor>("captures.anchor", { id: c.id }).then((a) => shell.openRecord(String(c.fields[F.source] ?? ""), where(a), { again: true })) },
      { label: "Copy embed", run: () => void navigator.clipboard?.writeText(`![[${c.title}|${c.id}]]`).then(() => toast("Embed copied: paste it into a note.")) },
      "separator",
      { label: "Delete", destructive: true, run: () => void deleteCapture(c) },
    ], at, "Capture");
  // ---- making a capture ---------------------------------------------------------------
  // Select text and a button appears by it; each choice adds a part to the capture being made,
  // which waits in a panel beside the document, its parts highlighted in place, until it is
  // saved. One draft per source (and snapshot); it survives leaving the item and coming back.
  const drafts = signal(new Map<string, Draft>());
  const keyOf = (source: string, part?: string) => `${source}|${part ?? ""}`;
  const draftOf = (k: string) => drafts().get(k);
  const setDraft = (k: string, d: Draft | null) => {
    const m = new Map(drafts.peek());
    if (d && (d.parts.length || d.words || d.editing)) m.set(k, d);
    else m.delete(k);
    drafts.set(m);
  };
  let n = 0;
  let active: { addSelection(): Promise<void>; addRegion(): Promise<void>; save(): Promise<void> } | null = null;
  // The capture being made, shown at the top of the side panel's Captures view (the reader
  // keeps the whole page).
  const draftShown = signal<{ source: string; el: HTMLElement } | null>(null);

  const tool: ReaderTool = {
    id: "capture",
    mount(toolbar, ctx) {
      const k = keyOf(ctx.source.id, ctx.part);
      const { view } = ctx;
      const stored = () => call<StoredText | null>("records.text", { id: ctx.source.id, part: ctx.part }).catch(() => null);

      const add = (p: DraftPart) => {
        const d = drafts.peek().get(k) ?? { parts: [], words: "" };
        setDraft(k, { ...d, parts: [...d.parts, p].sort(byOrder) });
      };

      /** A part from a selection (text, or a picture on its own), anchored in the stored text. */
      const partFromSelection = async (sel: ReaderSelection, key = `p${++n}`): Promise<{ part: DraftPart; found: boolean }> => {
        if (sel.image && !sel.text) {
          const selector: Selector[] = sel.cfi ? [{ type: "FragmentSelector", value: sel.cfi, conformsTo: CFI }] : [];
          const seg0 = sel.chapter !== undefined ? (await stored())?.segments[sel.chapter] : undefined;
          return { found: true, part: { key, selector, quote: "", locator: seg0?.label || null, region_png: sel.image.replace(/^data:image\/png;base64,/, ""), preview: sel.image, order: [sel.chapter ?? 0, 0, 0], boxes: [], region: true, cfi: sel.cfi } };
        }
        const st = await stored();
        const seg = st && (sel.page ? st.segments[sel.page - 1] : sel.chapter !== undefined ? st.segments[sel.chapter] : undefined);
        const at = st ? locateSelection(st.text, sel.text, seg ? { from: Number(seg.start), to: Number(seg.end) } : undefined) : null;
        const selector: Selector[] = at && st ? [...describe(st.text, at.start, at.end)] : [{ type: "TextQuoteSelector", exact: sel.text, prefix: "", suffix: "" }];
        if (sel.page) selector.push({ type: "FragmentSelector", value: `page=${sel.page}`, conformsTo: PDF_PAGE });
        if (sel.cfi) selector.push({ type: "FragmentSelector", value: sel.cfi, conformsTo: CFI });
        const quote = flowQuote(at && st ? sliceCp(st.text, at.start, at.end) : sel.text);
        const first = sel.boxes?.[0];
        return {
          found: !!at,
          part: {
            key,
            selector,
            quote,
            locator: seg?.label || (sel.page ? `p. ${sel.page}` : null),
            region_png: null,
            order: [first?.page ?? sel.page ?? sel.chapter ?? 0, first?.y ?? 0, at?.start ?? 0],
            boxes: sel.boxes ?? [],
            cfi: sel.cfi,
          },
        };
      };
      /** A region part (dragged out, or edited). */
      const partFromRegion = (r: { page?: number; x: number; y: number; w: number; h: number; png: string }, key = `p${++n}`): DraftPart => {
        const xywh = { type: "FragmentSelector" as const, value: `xywh=percent:${r.x},${r.y},${r.w},${r.h}`, conformsTo: MEDIA };
        const selector: Selector[] = r.page ? [{ type: "FragmentSelector", value: `page=${r.page}`, conformsTo: PDF_PAGE, refinedBy: xywh }] : [xywh];
        return { key, selector, quote: "", locator: r.page ? `p. ${r.page}` : null, region_png: r.png.replace(/^data:image\/png;base64,/, ""), preview: r.png, order: [r.page ?? 0, r.y, 0], boxes: [{ ...(r.page ? { page: r.page } : {}), x: r.x, y: r.y, w: r.w, h: r.h }], region: true };
      };

      const addSelection = async () => {
        const sel = view.selection?.();
        if (!sel) return shell.status.show("Select some text first.");
        hidePop();
        const { part, found } = await partFromSelection(sel);
        add(part);
        view.clearSelection?.();
        if (!found) shell.status.show("The stored text doesn’t contain that passage exactly; it was kept with its page only.", 6000);
      };

      const addRegion = async () => {
        if (!view.pickRegion) return shell.status.show("Regions can’t be captured in this kind of item.");
        hidePop();
        const r = await view.pickRegion();
        if (!r) return;
        add(partFromRegion(r));
      };

      const save = async () => {
        const d = drafts.peek().get(k);
        if (!d?.parts.length) return;
        if (d.editing) {
          try {
            let w = await call<Written>("captures.update", { id: d.editing.id, parts: d.parts.map(toPart) });
            shell.records.put(w.info, w.seq);
            // Renamed while editing.
            const title = d.editing.title.replace(/\s+/g, " ").trim();
            if (title && title !== d.editing.original && title !== w.info.title) {
              w = await call<Written>("records.relocate", { id: d.editing.id, title });
              shell.records.put(w.info, w.seq);
            }
            setDraft(k, null);
            toast("Capture updated.", { action: { label: "Open", run: () => shell.openRecord(w.info.id) } });
          } catch (e) {
            toast(String((e as { message?: string }).message ?? e));
          }
          return;
        }
        try {
          const st = await stored();
          const w = await call<Written>("captures.create", { source: ctx.source.id, snapshot: ctx.part ?? null, text: st?.origin ?? null, parts: d.parts.map(toPart), words: d.words });
          shell.records.put(w.info, w.seq);
          setDraft(k, null);
          toast("Captured.", { action: { label: "Open", run: () => shell.openRecord(w.info.id) } });
        } catch (e) {
          toast(String((e as { message?: string }).message ?? e));
        }
      };

      // The button by a selection: Capture, or Add to capture once one is being made.
      const popLabel = h("span");
      const pop = h("div", { class: "selection-pop", role: "toolbar", "aria-label": "Selection", hidden: true },
        h("button", { type: "button", onmousedown: (e: Event) => e.preventDefault(), onclick: () => void addSelection() }, icon(Highlighter, 14), popLabel));
      document.body.appendChild(pop);
      const hidePop = () => (pop.hidden = true);
      const showPop = () => {
        const sel = view.selection?.();
        if (!sel?.end) return hidePop();
        const parts = drafts.peek().get(k)?.parts.length ?? 0;
        popLabel.textContent = parts ? (sel.image && !sel.text ? "Add image to capture" : "Add to capture") : sel.image && !sel.text ? "Capture image" : "Capture";
        pop.hidden = false;
        const w = pop.offsetWidth || 120;
        const x = Math.max(8, Math.min(window.innerWidth - w - 8, sel.end.x - w / 2));
        const below = sel.end.bottom + 8;
        const y = below + 36 > window.innerHeight ? sel.end.y - 40 : below;
        Object.assign(pop.style, { left: `${x}px`, top: `${y}px` });
      };
      const unwatch = view.watchSelection?.(showPop) ?? (() => {});
      // A click on a saved highlight offers to open its capture.
      const markPop = h("div", { class: "selection-pop", role: "toolbar", "aria-label": "Capture", hidden: true });
      document.body.appendChild(markPop);
      const hideMarkPop = () => (markPop.hidden = true);
      const unwatchMarks = view.onMarkClick?.((ids, at) => {
        const caps = [...new Set(ids.map((id) => id.split("#")[0]!))].map((id) => saved.peek().find((c) => c.id === id)).filter((c): c is SavedMarks => !!c);
        if (!caps.length) return;
        hidePop();
        replace(markPop, caps.map((c) => h("button", { type: "button", title: c.title, onmousedown: (e: Event) => e.preventDefault(), onclick: () => (hideMarkPop(), shell.openRecord(c.id)) }, icon(Quote, 14), caps.length > 1 ? `Open “${c.title.slice(0, 28)}${c.title.length > 28 ? "…" : ""}”` : "Open capture")),
          caps.length === 1 && view.editParts ? h("button", { type: "button", title: "Edit what this capture holds", onmousedown: (e: Event) => e.preventDefault(), onclick: () => (hideMarkPop(), void startEdit(caps[0]!.id)) }, icon(Pencil, 14), "Edit") : null,
          caps.length === 1 ? h("button", { type: "button", title: "Delete this capture (it goes to the archive)", onmousedown: (e: Event) => e.preventDefault(), onclick: () => {
            hideMarkPop();
            const r = shell.records.get(caps[0]!.id);
            if (r) void deleteCapture(r);
          } }, icon(Trash2, 14), "Delete") : null);
        markPop.hidden = false;
        const w = markPop.offsetWidth || 140;
        Object.assign(markPop.style, { left: `${Math.max(8, Math.min(window.innerWidth - w - 8, at.x - w / 2))}px`, top: `${at.y + 36 > window.innerHeight ? at.y - 44 : at.y + 12}px` });
      }) ?? (() => {});
      const onAway = (e: MouseEvent) => {
        if (!markPop.hidden && !markPop.contains(e.target as Node)) hideMarkPop();
      };
      window.addEventListener("mousedown", onAway, true);
      const onScroll = () => {
        hidePop();
        markPop.hidden = true;
      };
      const onKey = (e: KeyboardEvent) => {
        if (e.key === "Escape" && !pop.hidden) hidePop();
        if (e.key === "Escape" && !markPop.hidden) markPop.hidden = true;
        // ⌘↩ saves the changes to a capture being edited.
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && drafts.peek().get(k)?.editing) {
          e.preventDefault();
          void save();
        }
      };
      document.addEventListener("scroll", onScroll, true);
      window.addEventListener("keydown", onKey);

      // ---- editing a saved capture's parts ----
      /** Loads a saved capture's parts into the draft, to edit them in place. */
      const startEdit = async (id: string) => {
        if (!view.editParts) return shell.status.show("Captures can’t be edited in this kind of item.");
        const cur = drafts.peek().get(k);
        if (cur?.editing?.id === id) return;
        if (cur?.parts.length && !cur.editing) return shell.status.show("Save or discard the capture being made first.", 5000);
        const r = shell.records.get(id);
        const a = await call<Anchor>("captures.anchor", { id }).catch(() => null);
        if (!r || !a) return shell.status.show("This capture can’t be found.");
        const parts: DraftPart[] = [];
        for (const [i, p] of a.parts.entries()) {
          const quote = flowQuote((p.selector.find((x) => x.type === "TextQuoteSelector") as { exact?: string } | undefined)?.exact ?? "");
          const frag = (prefix: string) => p.selector.flatMap((x) => [(x as { value?: string }).value, (x as { refinedBy?: { value?: string } }).refinedBy?.value]).find((v) => v?.startsWith(prefix));
          const page = Number(frag("page=")?.slice(5)) || undefined;
          const xywh = frag("xywh=percent:")?.slice(13).split(",").map(Number);
          const isRegion = !!p.region || !!xywh;
          const png = isRegion ? await call<string>("captures.region", { id, n: i + 1 }).catch(() => "") : "";
          parts.push({
            key: `p${++n}`,
            selector: p.selector,
            quote,
            locator: page ? `p. ${page}` : (r.fields[F.locator] as string | undefined) ?? null,
            region_png: png ? png.replace(/^data:image\/png;base64,/, "") : null,
            preview: png || undefined,
            order: [page ?? 0, p.boxes?.[0]?.y ?? xywh?.[1] ?? 0, i],
            boxes: p.boxes ?? (xywh ? [{ ...(page ? { page } : {}), x: xywh[0]!, y: xywh[1]!, w: xywh[2]!, h: xywh[3]! }] : []),
            region: isRegion,
            cfi: frag("epubcfi("),
          });
        }
        setDraft(k, { parts, words: "", editing: { id, title: r.title || "Capture", original: r.title || "Capture" } });
        shell.showPanelSection("captures");
        void view.showPlace?.(JSON.parse(JSON.stringify([...(a.parts[0]?.selector ?? []), ...(a.parts[0]?.boxes?.length ? [{ type: "librarium:boxes", boxes: a.parts[0].boxes }] : [])])));
      };
      const toEdit = (p: DraftPart): EditPart => {
        const xywh = p.region && p.boxes[0] ? p.boxes[0] : undefined;
        return { key: p.key, ...(xywh && !p.cfi ? { region: { ...(xywh.page ? { page: xywh.page } : {}), x: xywh.x, y: xywh.y, w: xywh.w, h: xywh.h } } : {}), boxes: p.boxes, cfi: p.cfi ?? null, quote: p.quote };
      };
      // A part dragged: redrawn as it moves; anchored again (quote, selectors) when let go.
      const edited = async (e: EditedPart) => {
        const d = drafts.peek().get(k);
        const old = d?.parts.find((x) => x.key === e.key);
        if (!d || !old) return;
        let next: DraftPart = old;
        if (e.text) {
          next = e.done ? (await partFromSelection(e.text, e.key)).part : { ...old, boxes: e.text.boxes ?? old.boxes, cfi: e.text.cfi ?? old.cfi, quote: e.text.text };
        } else if (e.region) {
          next = e.done && e.region.png ? partFromRegion({ ...e.region, png: e.region.png }, e.key) : { ...old, boxes: [{ ...(e.region.page ? { page: e.region.page } : {}), x: e.region.x, y: e.region.y, w: e.region.w, h: e.region.h }] };
        }
        const cur = drafts.peek().get(k);
        if (!cur) return;
        setDraft(k, { ...cur, parts: cur.parts.map((x) => (x.key === e.key ? next : x)).sort(byOrder) });
      };
      // The editor follows the draft: started with an edit, given new parts when one is added or
      // removed (not on every drag: that would take the handle away mid-drag), stopped after.
      let editor: PartsEditor | null = null;
      let editorKeys = "";
      const stopEditor = effect(() => {
        const d = draftOf(k);
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
      });
      // Asked for by the route (Edit selection, from the capture page).
      let lastEditRoute: unknown = null;
      const stopEditRoute = effect(() => {
        const r = shell.router.current();
        if (r === lastEditRoute) return;
        lastEditRoute = r;
        if (r.page === "item" && r.params.id === ctx.source.id && r.params.edit) untracked(() => void startEdit(r.params.edit!));
      });

      // The capture being made: in the side panel's Captures view, opened when it begins.
      const panel = h("section", { class: "capture-draft", "aria-label": "New capture" });
      const hidePanel = () => {
        panel.remove();
        if (draftShown.peek()?.el === panel) draftShown.set(null);
      };
      // Captures already made from this source (this snapshot of it), highlighted softly; kept
      // up to date as captures are made, archived or deleted.
      const saved = signal<SavedMarks[]>([]);
      let asked = 0;
      let lastSig = "";
      const stopSaved = effect(() => {
        const mine = shell.records.list(KIND).filter((c) => c.fields[F.source] === ctx.source.id && !isArchived(c));
        // Ask again only when this source's captures change (not on every change elsewhere).
        const sig = mine.map((c) => `${c.id}:${c.version}`).sort().join();
        if (sig === lastSig) return;
        lastSig = sig;
        const visible = new Set(mine.map((c) => c.id));
        const n = ++asked;
        if (!mine.length) return void saved.set([]);
        void call<SavedMarks[]>("captures.forSource", { source: ctx.source.id, snapshot: ctx.part ?? null }).then(
          (list) => n === asked && saved.set(list.filter((c) => visible.has(c.id))),
          () => {},
        );
      });
      const editBar = h("div", { class: "capture-edit-bar", role: "toolbar", "aria-label": "Editing a capture" });
      const stopPanel = effect(() => {
        const d = draftOf(k);
        const savedMarks = saved().filter((c) => c.id !== d?.editing?.id).flatMap((c) => c.parts.map((p, i) => ({ id: `${c.id}#${i}`, boxes: p.boxes, region: p.region, cfi: p.region ? undefined : (p.cfi ?? undefined), saved: true })));
        view.setMarks?.([...savedMarks, ...(d?.parts ?? []).map((p) => ({ id: p.key, boxes: p.boxes, region: p.region, cfi: p.region ? undefined : p.cfi }))]);
        // Editing a saved capture: the reader stays whole; its controls are in the Captures list
        // (side panel) and a small bar over the document.
        if (d?.editing) {
          hidePanel();
          untracked(() => renderEditBar(d));
          return;
        }
        editBar.remove();
        if (!d?.parts.length) {
          hidePanel();
          return;
        }
        untracked(() => renderPanel(d));
        if (draftShown.peek()?.el !== panel) {
          draftShown.set({ source: ctx.source.id, el: panel });
          if (untracked(() => shell.router.current()).page === "item") shell.showPanelSection("captures");
        }
      });
      function renderEditBar(d: Draft) {
        replace(editBar,
          h("span", { class: "edit-bar-title" }, `Editing “${d.editing!.title}”`, h("span", { class: "muted" }, ` · ${d.parts.length === 1 ? "1 part" : `${d.parts.length} parts`}`)),
          h("button", { class: "button", type: "button", onclick: () => setDraft(k, null) }, "Cancel"),
          h("button", { class: "button primary", type: "button", title: "Save changes (⌘↩)", disabled: !d.parts.length, onclick: () => void save() }, "Save changes"));
        const body = ctx.aside.parentElement;
        if (body && !editBar.isConnected) body.appendChild(editBar);
      }
      function renderPanel(d: Draft) {
        const items: HTMLElement[] = [];
        d.parts.forEach((p, i) => {
          if (i) items.push(h("div", { class: "draft-gap", "aria-hidden": "true" }, "[…]"));
          const remove = h("button", { class: "icon-button remove", type: "button", "aria-label": "Remove this part", title: "Remove this part", onclick: () => setDraft(k, { ...d, parts: d.parts.filter((x) => x !== p) }) }, icon(X, 14));
          const body = p.preview ? h("img", { class: "capture-region", src: p.preview, alt: "The region" }) : h("blockquote", { class: "capture-quote" }, p.quote);
          items.push(h("div", { class: "draft-part" }, body, remove));
        });
        const locs = [...new Set(d.parts.map((p) => p.locator).filter(Boolean))];
        const words = h("textarea", { class: "words-input", rows: 3, placeholder: "Your words (optional)", "aria-label": "Your words" }) as HTMLTextAreaElement;
        words.value = d.words;
        words.addEventListener("input", () => {
          const cur = drafts.peek().get(k);
          if (cur) drafts.peek().set(k, { ...cur, words: words.value });
        });
        words.addEventListener("keydown", (e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            e.stopPropagation();
            void save();
          }
        });
        const hadFocus = panel.contains(document.activeElement) && document.activeElement?.classList.contains("words-input");
        replace(panel,
          h("div", { class: "capture-draft-head" }, h("h2", null, d.parts.length > 1 ? `New capture · ${d.parts.length} parts` : "New capture")),
          ...items,
          h("p", { class: "draft-hint" }, view.pickRegion ? "Select more text, or drag a region (⇧⌘R), to add to it." : "Select more text to add to it."),
          h("p", { class: "muted small" }, `From ${ctx.source.title}${locs.length ? `, ${locs.join(", ")}` : ""}`),
          words,
          h("div", { class: "ask-buttons" },
            h("button", { class: "button", type: "button", onclick: () => setDraft(k, null) }, "Discard"),
            h("button", { class: "button primary", type: "button", title: "Save capture (⌘↩)", onclick: () => void save() }, "Save capture")),
        );
        if (hadFocus) words.focus();
      }

      const b1 = h("button", { class: "icon-button", "aria-label": "Capture the selection", title: "Capture the selection (⇧⌘C)", onclick: () => void addSelection() }, icon(Highlighter));
      const b2 = view.pickRegion ? h("button", { class: "icon-button", "aria-label": "Capture a region", title: "Capture a region (⇧⌘R)", onclick: () => void addRegion() }, icon(Crop)) : null;
      toolbar.append(b1, ...(b2 ? [b2] : []));
      active = { addSelection, addRegion, save };
      return () => {
        stopEditor();
        stopEditRoute();
        editBar.remove();
        editor?.stop();
        stopSaved();
        unwatchMarks();
        window.removeEventListener("mousedown", onAway, true);
        markPop.remove();
        stopPanel();
        unwatch();
        document.removeEventListener("scroll", onScroll, true);
        window.removeEventListener("keydown", onKey);
        pop.remove();
        hidePanel();
        active = null;
        b1.remove();
        b2?.remove();
      };
    },
  };
  shell.slot<ReaderTool>(READER_TOOLS).add("captures", "capture", tool);
  const onItem = () => shell.router.current().page === "item";
  shell.actions.add("captures", {
    id: "captures.captureSelection",
    title: "Capture the selection",
    keys: ["Mod+Shift+C"],
    when: onItem,
    menu: { name: "edit", group: 2 },
    icon: Highlighter,
    run: () => void active?.addSelection(),
  });
  shell.actions.add("captures", {
    id: "captures.captureRegion",
    title: "Capture a region",
    keys: ["Mod+Shift+R"],
    when: onItem,
    menu: { name: "edit", group: 2 },
    icon: Crop,
    run: () => void active?.addRegion(),
  });
  shell.actions.add("captures", {
    id: "captures.save",
    title: "Save the capture",
    keys: ["Mod+Enter"],
    when: () => onItem() && [...drafts().keys()].some((key) => key.startsWith(`${shell.router.current().params.id}|`)),
    menu: { name: "edit", group: 2 },
    run: () => void active?.save(),
  });

  // ---- embeds ---------------------------------------------------------------------------
  /**
   * A part's place for the reader: its selectors, and where it was drawn on the page (boxes),
   * which take the reader straight to it (text search can miss: R-028). The boxes selector is
   * Librarium's own and only travels in the route; it is never stored.
   */
  const placeFor = (part: Anchor["parts"][number] | undefined) =>
    part ? JSON.stringify([...part.selector, ...(part.boxes?.length ? [{ type: "librarium:boxes", boxes: part.boxes }] : [])]) : undefined;
  /** Where to open a capture's source: its place (a part's, or the first), in the snapshot it came from. */
  const where = (anchor: Anchor | null, part?: Anchor["parts"][number]): Record<string, string> => ({ place: placeFor(part ?? anchor?.parts[0]) ?? "", ...(anchor?.snapshot ? { snapshot: anchor.snapshot } : {}) });
  shell.embeds.add("captures", KIND, {
    kind: KIND,
    render(r, open) {
      const quote = flowQuote(String(r.fields[F.quote] ?? ""));
      const src = String(r.fields[F.source] ?? "");
      const cite = h("a", { href: "#", class: "embed-cite", onclick: (e: Event) => {
        e.preventDefault();
        void call<Anchor>("captures.anchor", { id: r.id }).then((a) => open(src, where(a)), () => open(src));
      } }, `— ${citation(shell, r)}`);
      const partsN = Number(r.fields["captures.parts"] ?? 1);
      const edit = h("button", { type: "button", class: "embed-edit", title: "Open the capture to edit it", onclick: (e: Event) => (e.preventDefault(), open(r.id)) }, "Edit");
      const archived = isArchived(r) ? h("span", { class: "badge", title: "This capture is in the archive" }, "In the archive") : null;
      const block = h("figure", { class: "embed" }, quote ? h("blockquote", { class: "embed-quote" }, quote) : null, h("figcaption", null, cite, archived, edit));
      // Several parts, or a picture: each part in order, pictures as pictures.
      if (partsN > 1 || !quote) {
        void call<Anchor>("captures.anchor", { id: r.id }).then((a) => {
          const nodes: HTMLElement[] = [];
          a.parts.forEach((p, i) => {
            if (i) nodes.push(h("div", { class: "embed-gap", "aria-hidden": "true" }, "[…]"));
            const isRegion = !!p.region || p.selector.some((x) => [(x as { value?: string }).value, (x as { refinedBy?: { value?: string } }).refinedBy?.value].some((v) => v?.startsWith("xywh=")));
            if (isRegion) {
              const img = h("img", { class: "capture-region embed-region", alt: "A captured picture" });
              void call<string>("captures.region", { id: r.id, n: i + 1 }).then((d) => (img.src = d), () => {});
              nodes.push(img);
            } else nodes.push(h("blockquote", { class: "embed-quote" }, flowQuote((p.selector.find((x) => x.type === "TextQuoteSelector") as { exact?: string } | undefined)?.exact ?? "")));
          });
          block.querySelectorAll(":scope > .embed-quote, :scope > .capture-region").forEach((x) => x.remove());
          block.prepend(...nodes);
        }, () => {});
      }
      return block;
    },
    markdown(r) {
      const quote = flowQuote(String(r.fields[F.quote] ?? "")) || "[a captured region]";
      return `${quote.split("\n").map((l) => `> ${l}`).join("\n")}\n>\n> — ${citation(shell, r)}`;
    },
  });
  shell.editorExtensions.add("captures", "capture-embeds", { id: "capture-embeds", handlesEmbeds: true, extension: () => embedExtension(shell) });

  // ---- the capture page ---------------------------------------------------------------
  // ---- all captures: a page to look through them --------------------------------------
  const groupPref = shell.prefs.pref<"source" | "newest">("captures.group", "source");
  const showPref = shell.prefs.pref<"all" | "passages" | "pictures">("captures.show", "all");
  shell.pages.add("captures", "captures", {
    id: "captures",
    title: "Captures",
    icon: Quote,
    ribbon: 2.5,
    keys: "Mod+Shift+K",
    render(host, _params, ctx) {
      ctx.setTitle("Captures");
      const query = signal("");
      const search = h("input", { class: "search-input captures-search", type: "search", placeholder: "Search captures", "aria-label": "Search captures", spellcheck: false }) as HTMLInputElement;
      let t: ReturnType<typeof setTimeout> | undefined;
      search.addEventListener("input", () => {
        clearTimeout(t);
        t = setTimeout(() => query.set(search.value), 120);
      });
      const seg = <T extends string>(label: string, pref: { (): T; set(v: T): void }, options: [T, string][]) =>
        h("div", { class: "seg small-seg", role: "radiogroup", "aria-label": label }, options.map(([v, text]) => {
          const b = h("button", { type: "button", role: "radio", "data-value": v, onclick: () => pref.set(v) }, text);
          return b;
        }));
      const groupSeg = seg("Arrange", groupPref, [["source", "By source"], ["newest", "Newest first"]]);
      const showSeg = seg("Show", showPref, [["all", "All"], ["passages", "Passages"], ["pictures", "Pictures"]]);
      const count = h("span", { class: "muted small" });
      const list = h("div", { class: "captures-page-list" });
      replace(host, h("div", { class: "captures-page" },
        h("div", { class: "captures-page-head" }, h("h1", { class: "page-title" }, "Captures"), count),
        h("div", { class: "captures-page-tools" }, search, groupSeg, showSeg),
        list));
      const pictureOf = (c: RecordInfo) => !String(c.fields[F.quote] ?? "").trim();
      const thumbs = new Map<string, string>();
      const card = (c: RecordInfo, withSource: boolean): HTMLElement => {
        const quote = flowQuote(String(c.fields[F.quote] ?? ""));
        const srcId = String(c.fields[F.source] ?? "");
        const src = shell.records.get(srcId);
        const named = quote && !quote.startsWith(c.title.replace(/…$/, ""));
        let body: HTMLElement;
        if (pictureOf(c)) {
          const img = h("img", { class: "capture-thumb", alt: c.title || "A captured picture" }) as HTMLImageElement;
          const known = thumbs.get(c.id);
          if (known) img.src = known;
          else void call<string>("captures.region", { id: c.id, n: 1 }).then((d) => (thumbs.set(c.id, d), (img.src = d)), () => {});
          body = img;
        } else body = h("blockquote", { class: "capture-card-quote" }, quote);
        const when = c.created ? new Date(c.created).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : "";
        const meta = [named ? c.title : null, withSource ? src?.title : null, (c.fields[F.locator] as string | undefined) ?? null, when].filter(Boolean).join(" · ");
        const el = h("article", { class: "capture-card", tabindex: "0", "aria-label": c.title || "Capture" },
          h("div", { class: "capture-card-body" }, body, h("div", { class: "capture-card-meta muted small" }, meta)),
          h("div", { class: "row tight capture-tools" },
            iconButton(LocateFixed, "Show in the source", () => void call<Anchor>("captures.anchor", { id: c.id }).then((a) => shell.openRecord(srcId, where(a), { again: true }))),
            iconButton(Pencil, "Edit selection", () => void call<Anchor>("captures.anchor", { id: c.id }).then((a) => shell.openRecord(srcId, { ...where(a), edit: c.id }, { again: true }))),
            iconButton(Copy, "Copy embed", () => void navigator.clipboard?.writeText(`![[${c.title}|${c.id}]]`).then(() => toast("Embed copied: paste it into a note."))),
            iconButton(Trash2, "Delete", () => void deleteCapture(c), true)));
        el.addEventListener("click", (e) => {
          if ((e.target as Element).closest("button")) return;
          shell.openRecord(c.id);
        });
        el.addEventListener("keydown", (e) => {
          if (e.key === "Enter" && e.target === el) shell.openRecord(c.id);
        });
        el.addEventListener("contextmenu", (e) => {
          e.preventDefault();
          captureMenu(c, { x: e.clientX, y: e.clientY });
        });
        return el;
      };
      const stop = effect(() => {
        const all = shell.records.list(KIND).filter((c) => !isArchived(c));
        const q = query().trim().toLowerCase().split(/\s+/).filter(Boolean);
        const group = groupPref();
        const show = showPref();
        for (const b of groupSeg.querySelectorAll<HTMLElement>("button")) b.setAttribute("aria-checked", String(b.dataset.value === group));
        for (const b of showSeg.querySelectorAll<HTMLElement>("button")) b.setAttribute("aria-checked", String(b.dataset.value === show));
        const hay = (c: RecordInfo) => [c.title, c.fields[F.quote], c.fields[F.locator], shell.records.get(String(c.fields[F.source] ?? ""))?.title].filter(Boolean).join(" ").toLowerCase();
        const shown = all
          .filter((c) => (show === "all" ? true : show === "pictures" ? pictureOf(c) : !pictureOf(c)))
          .filter((c) => q.every((w) => hay(c).includes(w)))
          .sort((a, b) => (b.created ?? "").localeCompare(a.created ?? ""));
        count.textContent = shown.length === all.length ? `${all.length} ${all.length === 1 ? "capture" : "captures"}` : `${shown.length} of ${all.length}`;
        if (!all.length) return replace(list, h("p", { class: "empty" }, "No captures yet. In a book, article or PDF, select a passage (or drag a region) and choose Capture."));
        if (!shown.length) return replace(list, h("p", { class: "empty" }, "No captures match."));
        if (group === "newest") return replace(list, h("div", { class: "capture-cards" }, shown.map((c) => card(c, true))));
        // By source: the sources with the latest capture first; a source's captures in order.
        const bySrc = new Map<string, RecordInfo[]>();
        for (const c of shown) {
          const k = String(c.fields[F.source] ?? "");
          bySrc.set(k, [...(bySrc.get(k) ?? []), c]);
        }
        replace(list, [...bySrc.entries()].map(([srcId, cs]) => {
          const src = shell.records.get(srcId);
          return h("section", { class: "capture-group", "aria-label": src?.title ?? "A source" },
            h("h2", { class: "capture-group-head" },
              h("a", { href: "#", class: "list-link", onclick: (e: Event) => (e.preventDefault(), src && shell.openRecord(srcId)) }, src?.title ?? "A source no longer in the library"),
              h("span", { class: "muted small" }, ` ${cs.length}`)),
            h("div", { class: "capture-cards" }, cs.sort((a, b) => (a.created ?? "").localeCompare(b.created ?? "")).map((c) => card(c, false))));
        }));
      });
      search.focus();
      return () => {
        clearTimeout(t);
        stop();
      };
    },
  });

  shell.pages.add("captures", "capture", {
    id: "capture",
    title: "Capture",
    icon: Quote,
    render(host, params, ctx) {
      const id = params.id ?? "";
      let alive = true;
      let cleanup: (() => void)[] = [];
      void (async () => {
        const t = await call<RecordText>("records.read", { id }).catch(() => null);
        if (!alive) return;
        if (!t) return replace(host, h("p", { class: "empty" }, "This capture can’t be found any more."));
        const r = t.info;
        ctx.setTitle(r.title || "Capture");
        const anchor = await call<Anchor>("captures.anchor", { id }).catch(() => null);
        const st = anchor ? await statuses(anchor) : [];
        const src = String(r.fields[F.source] ?? "");
        const partsEl = h("div", { class: "capture-parts" });
        anchor?.parts.forEach((p, i) => {
          const s = st[i];
          const quote = p.selector.find((x) => x.type === "TextQuoteSelector") as { exact: string } | undefined;
          const show = () => shell.openRecord(src, where(anchor, p), { again: true });
          const body = quote ? h("blockquote", { class: "capture-quote" }, flowQuote(quote.exact)) : h("img", { class: "capture-region", alt: "The captured region" });
          if (!quote) void call<string>("captures.region", { id, n: i + 1 }).then((d) => ((body as HTMLImageElement).src = d), () => {});
          const badge = s?.status === "moved" ? h("span", { class: "badge moved" }, "moved — check it") : s?.status === "lost" ? h("span", { class: "badge lost" }, "lost") : null;
          const confirm = s?.status === "moved" ? h("button", { class: "link-button", onclick: () => void confirmMoved(id, anchor, i, src).then(() => shell.router.go("capture", { id }, { replace: true })) }, "This is the place") : null;
          // Show is in the header; with several parts, each part can be shown on its own too.
          const many = (anchor?.parts.length ?? 0) > 1;
          const tools = many || badge || confirm ? h("div", { class: "row tight capture-tools" }, many ? iconButton(LocateFixed, `Show part ${i + 1} in the source`, show) : null, badge, confirm) : null;
          partsEl.appendChild(h("div", { class: "capture-part" }, body, tools));
        });
        const cite = h("p", { class: "muted" }, "— ", h("a", { href: "#", class: "list-link", onclick: (e: Event) => (e.preventDefault(), shell.openRecord(src, where(anchor), { again: true })) }, citation(shell, r)));
        const editorHost = h("div", { class: "editor-host" });
        // The title renames the capture (the quote itself stays exact).
        let info = r;
        const titleInput = h("input", { class: "page-title title-input", value: r.title || "", "aria-label": "Title", spellcheck: true }) as HTMLInputElement;
        const archived = isArchived(r) ? h("p", { class: "notice" }, "This capture is in the archive.") : null;
        replace(host, archived, titleInput, partsEl, cite, h("h2", { class: "list-heading" }, "Your words"), editorHost);
        const session = new NoteSession(id, r.version, t.body, {
          current: () => view.state.doc.toString(),
          merged: () => {},
          conflict: async () => null,
          status: (m, p) => shell.status.show(m, p ? 0 : 4000),
          saved: (seq) => void shell.records.waitFor(seq),
        });
        const view = createEditor({ parent: editorHost, doc: t.body, label: "Your words", targets: () => [], open: (x, opts) => shell.openRecord(x, {}, opts), titleOf: (x) => shell.records.get(x)?.title ?? null, onChange: () => session.changed(), onBlur: () => void session.flush(), placeholder: "Write why this matters…" });
        cleanup.push(() => (void session.close(), view.destroy()), shell.beforeClose(() => session.close()));
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
            // Undo and redo each expect the version the step before produced.
            let version = w.info.version;
            const retitle = async (to: string) => {
              const x = await call<Written>("records.relocate", { id, title: to, base_version: version });
              version = x.info.version;
              shell.records.put(x.info, x.seq);
              if (shell.router.current.peek().params.id === id) {
                info = x.info;
                titleInput.value = to;
                ctx.setTitle(to);
                session.rebase(x.info.version, session.savedBody);
              }
            };
            shell.undo.done(`Renamed to “${title}”`, {
              label: `rename to “${title}”`,
              undo: () => retitle(before),
              redo: () => retitle(title),
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
          h("button", { class: "icon-button", "aria-label": "Show in the source", title: "Show in the source", onclick: () => shell.openRecord(src, where(anchor), { again: true }) }, icon(LocateFixed)),
          h("button", { class: "icon-button", "aria-label": "Edit selection", title: "Edit what this capture holds, in its source (drag a passage’s ends, resize a region)", onclick: () => shell.openRecord(src, { ...where(anchor), edit: id }, { again: true }) }, icon(Pencil)),
          h("button", { class: "icon-button", "aria-label": "Copy embed", title: "Copy embed (paste it into a note)", onclick: () => void navigator.clipboard?.writeText(`![[${info.title}|${id}]]`).then(() => toast("Embed copied: paste it into a note.")) }, icon(Copy)),
          h("button", { class: "icon-button", "aria-label": "Export as W3C annotations", title: "Export as W3C annotations", onclick: () => void exportW3C(shell, r, t.body) }, icon(FileDown)),
          isArchived(r) ? null : h("button", { class: "icon-button", "aria-label": "Delete capture", title: "Delete (it goes to the archive, where you can restore it or delete it for good)", onclick: async () => {
            await session.flush();
            if (await deleteCapture(shell.records.get(id) ?? info)) {
              if (shell.router.canBack()) shell.router.back();
            }
          } }, icon(Trash2)),
        ].filter((x): x is HTMLButtonElement => !!x));
      })();
      return () => {
        alive = false;
        cleanup.forEach((c) => c());
        cleanup = [];
      };
    },
  });

  // ---- the captures panel -------------------------------------------------------------
  shell.sidePanel.add("captures", "captures", {
    id: "captures",
    title: "Captures",
    icon: Quote,
    // On a library item, and on one of its captures (the list stays, the open one marked).
    applies: (r) => (r.page === "item" || r.page === "capture") && !!r.params.id,
    render(host, route) {
      const open = route.page === "capture" ? route.params.id! : null;
      const src = open ? String(shell.records.get(open)?.fields[F.source] ?? "") : route.params.id!;
      let alive = true;
      const statusOf = new Map<string, string>();
      // The capture being made from this source, above the list.
      const draftHost = h("div", { class: "capture-draft-host" });
      const listHost = h("div");
      replace(host, draftHost, listHost);
      const stopDraft = effect(() => {
        const d = draftShown();
        if (d && d.source === src) {
          if (d.el.parentElement !== draftHost) replace(draftHost, d.el);
        } else draftHost.replaceChildren();
      });
      const stop = effect(() => {
        const list = shell.records.list(KIND).filter((c) => c.fields[F.source] === src && !isArchived(c));
        const editing = [...drafts().entries()].find(([, d]) => d.editing && list.some((c) => c.id === d.editing!.id));
        if (!list.length) return replace(listHost, h("p", { class: "muted" }, draftShown()?.source === src ? "" : "Nothing captured here yet. Select a passage and choose Capture."));
        const ul = h("ul", { class: "backlinks capture-list" });
        replace(listHost, ul);
        for (const c of list.sort((x, y) => (x.created ?? "").localeCompare(y.created ?? ""))) {
          const status = h("span", { class: `badge ${statusOf.get(c.id) ?? ""}` }, statusOf.get(c.id) ?? "");
          const isEditing = editing?.[1].editing?.id === c.id;
          const li = h("li", { class: `capture-row${c.id === open ? " current" : ""}${isEditing ? " editing" : ""}`, "aria-current": c.id === open ? "true" : undefined },
            isEditing ? titleField(editing![0], editing![1]) : h("a", { href: "#", class: "list-link", onclick: (e: Event) => (e.preventDefault(), shell.openRecord(c.id)) }, c.title || "Capture"), " ", status,
            isEditing ? editingControls(editing![0], editing![1]) : h("div", { class: "row tight capture-tools" },
              iconButton(LocateFixed, "Show in the source", () => void call<Anchor>("captures.anchor", { id: c.id }).then((a) => shell.openRecord(src, where(a), { again: true }))),
              iconButton(Pencil, "Edit selection", () => void call<Anchor>("captures.anchor", { id: c.id }).then((a) => shell.openRecord(src, { ...where(a), edit: c.id }, { again: true }))),
              iconButton(Copy, "Copy embed", () => void navigator.clipboard?.writeText(`![[${c.title}|${c.id}]]`).then(() => toast("Embed copied: paste it into a note."))),
              iconButton(Trash2, "Delete", () => void deleteCapture(c), true)));
          li.addEventListener("contextmenu", (e) => {
            e.preventDefault();
            captureMenu(c, { x: e.clientX, y: e.clientY });
          });
          ul.appendChild(li);
          if (!statusOf.has(c.id)) {
            void call<Anchor>("captures.anchor", { id: c.id }).then(statuses).then((st) => {
              if (!alive) return;
              const worst = st.some((x) => x.status === "lost") ? "lost" : st.some((x) => x.status === "moved") ? "moved" : "";
              statusOf.set(c.id, worst);
              status.textContent = worst;
              status.className = `badge ${worst}`;
            }, () => {});
          }
        }
        if (open) ul.querySelector(".current")?.scrollIntoView?.({ block: "nearest" });
      });
      return () => {
        alive = false;
        stop();
        stopDraft();
      };
    },
  });

  /** The name of a capture being edited, to change with its parts (saved with them). */
  function titleField(k: string, d: Draft): HTMLElement {
    const input = h("input", { class: "edit-title", type: "text", value: d.editing!.title, "aria-label": "Name of the capture", spellcheck: true }) as HTMLInputElement;
    // Kept in the draft without redrawing the list (which would take the focus away).
    input.addEventListener("input", () => {
      const cur = drafts.peek().get(k);
      if (cur?.editing) drafts.peek().set(k, { ...cur, editing: { ...cur.editing, title: input.value } });
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.isComposing) {
        e.preventDefault();
        void active?.save();
      }
    });
    return input;
  }

  /** The parts of a capture being edited, with Cancel and Save, in its row of the Captures list. */
  function editingControls(k: string, d: Draft): HTMLElement {
    const parts = d.parts.map((p, i) =>
      h("div", { class: "edit-part" },
        p.preview ? h("img", { class: "edit-part-img", src: p.preview, alt: "A captured picture" }) : h("span", { class: "edit-part-text" }, p.quote.length > 90 ? `${p.quote.slice(0, 90)}…` : p.quote),
        h("button", { type: "button", class: "icon-button small", "aria-label": `Remove part ${i + 1}`, title: "Remove this part", onclick: () => setDraft(k, { ...d, parts: d.parts.filter((x) => x !== p) }) }, icon(X, 14))));
    return h("div", { class: "edit-controls" },
      h("p", { class: "edit-hint" }, "Editing: drag the handles at a passage’s ends, or a region’s frame. Select more to add a part."),
      ...parts,
      h("div", { class: "ask-buttons" },
        h("button", { class: "button", type: "button", onclick: () => setDraft(k, null) }, "Cancel"),
        h("button", { class: "button primary", type: "button", disabled: !d.parts.length, onclick: () => void active?.save() }, "Save changes")));
  }

  // Captures show under the item they were made from (in the Library's tree).
  let bySource: { from: unknown; map: Map<string, RecordInfo[]> } | null = null;
  const capturesOf = (sourceId: string): RecordInfo[] => {
    const from = shell.records.byId();
    if (bySource?.from !== from) {
      const map = new Map<string, RecordInfo[]>();
      for (const c of shell.records.list(KIND)) {
        if (isArchived(c)) continue;
        const src = String(c.fields[F.source] ?? "");
        if (src) map.set(src, [...(map.get(src) ?? []), c]);
      }
      for (const list of map.values()) list.sort((a, b) => (a.created ?? "").localeCompare(b.created ?? ""));
      bySource = { from, map };
    }
    return bySource.map.get(sourceId) ?? [];
  };
  shell.slot<ItemChildren>(ITEM_CHILDREN).add("captures", "captures", {
    children: (item) => capturesOf(item.id).map((c) => ({ id: c.id, label: c.title || "Capture", icon: Quote, current: shell.router.current().params.id === c.id, onActivate: () => shell.openRecord(c.id), onContext: (at) => void captureMenu(c, at) })),
  });

  shell.settings.add("captures", "orphans", {
    id: "orphans",
    title: "Captures",
    render(host) {
      void call<{ path: string }[]>("captures.orphans").then((o) => replace(host, o.length ? [h("p", { class: "muted small" }, "These files belong to captures that no longer exist. They are kept; you can remove them yourself."), h("ul", { class: "plain-list" }, o.map((x) => h("li", { class: "small" }, x.path)))] : h("p", { class: "muted small" }, "Every capture file belongs to a capture.")), () => {});
    },
  }, 60);
}

/** The user confirms a moved part's new place: the anchor now points there. */
async function confirmMoved(id: string, anchor: Anchor, i: number, src: string): Promise<void> {
  const stored = await call<StoredText | null>("records.text", { id: src, part: anchor.snapshot ?? undefined });
  if (!stored) return;
  const loc = locate(stored.text, anchor.parts[i]!.selector);
  if (loc.start === undefined) return;
  const [quote, pos] = describe(stored.text, loc.start, loc.end!);
  const parts = anchor.parts.map((p, k) => (k !== i ? p : { ...p, selector: [quote, pos, ...p.selector.filter((s) => s.type !== "TextQuoteSelector" && s.type !== "TextPositionSelector")] }));
  await call("captures.updateAnchor", { id, parts });
  toast("The capture now points to its new place.");
}

async function exportW3C(shell: ShellApi, r: RecordInfo, words: string): Promise<void> {
  const { pickSavePath } = await import("../../backend");
  const anchor = await call<Anchor & { snapshot: string | null; text: null }>("captures.anchor", { id: r.id });
  const path = await pickSavePath(`${r.title || "capture"}.jsonld`, "Export as W3C annotations");
  if (!path) return;
  const json = JSON.stringify(toW3C({ ...anchor, snapshot: anchor.snapshot ?? null, text: null } as never, words.trim(), `urn:uuid:${anchor.source}`, r.created ?? new Date().toISOString()), null, 2);
  await call("export.write", { path, text: json });
  shell.status.show("Exported.");
}
