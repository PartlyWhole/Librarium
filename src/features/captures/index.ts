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
import { Highlighter, Crop, Quote, FileDown, X } from "lucide";
import type { Box } from "../../reader/host";

export const KIND = "capture";
const F = { source: "captures.source", quote: "captures.quote", locator: "captures.locator" };
const PDF_PAGE = "http://tools.ietf.org/rfc/rfc8118";
const MEDIA = "http://www.w3.org/TR/media-frags/";
const CFI = "http://www.idpf.org/epub/linking/cfi/epub-cfi.html";

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
  parts: { selector: Selector[]; region?: string }[];
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
  // ---- making a capture ---------------------------------------------------------------
  // Select text and a button appears by it; each choice adds a part to the capture being made,
  // which waits in a panel beside the document, its parts highlighted in place, until it is
  // saved. One draft per source (and snapshot); it survives leaving the item and coming back.
  const drafts = signal(new Map<string, Draft>());
  const keyOf = (source: string, part?: string) => `${source}|${part ?? ""}`;
  const draftOf = (k: string) => drafts().get(k);
  const setDraft = (k: string, d: Draft | null) => {
    const m = new Map(drafts.peek());
    if (d && (d.parts.length || d.words)) m.set(k, d);
    else m.delete(k);
    drafts.set(m);
  };
  let n = 0;
  let active: { addSelection(): Promise<void>; addRegion(): Promise<void>; save(): Promise<void> } | null = null;

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

      const addSelection = async () => {
        const sel = view.selection?.();
        if (!sel) return shell.status.show("Select some text first.");
        hidePop();
        const st = await stored();
        const seg = st && (sel.page ? st.segments[sel.page - 1] : sel.chapter !== undefined ? st.segments[sel.chapter] : undefined);
        const at = st ? locateSelection(st.text, sel.text, seg ? { from: Number(seg.start), to: Number(seg.end) } : undefined) : null;
        const selector: Selector[] = at && st ? [...describe(st.text, at.start, at.end)] : [{ type: "TextQuoteSelector", exact: sel.text, prefix: "", suffix: "" }];
        if (sel.page) selector.push({ type: "FragmentSelector", value: `page=${sel.page}`, conformsTo: PDF_PAGE });
        if (sel.cfi) selector.push({ type: "FragmentSelector", value: sel.cfi, conformsTo: CFI });
        const quote = at && st ? sliceCp(st.text, at.start, at.end) : sel.text;
        const first = sel.boxes?.[0];
        add({
          key: `p${++n}`,
          selector,
          quote,
          locator: seg?.label || (sel.page ? `p. ${sel.page}` : null),
          region_png: null,
          order: [first?.page ?? sel.page ?? sel.chapter ?? 0, first?.y ?? 0, at?.start ?? 0],
          boxes: sel.boxes ?? [],
          cfi: sel.cfi,
        });
        view.clearSelection?.();
        if (!at) shell.status.show("The stored text doesn’t contain that passage exactly; it was kept with its page only.", 6000);
      };

      const addRegion = async () => {
        if (!view.pickRegion) return shell.status.show("Regions can’t be captured in this kind of item.");
        hidePop();
        const r = await view.pickRegion();
        if (!r) return;
        const xywh = { type: "FragmentSelector" as const, value: `xywh=percent:${r.x},${r.y},${r.w},${r.h}`, conformsTo: MEDIA };
        const selector: Selector[] = r.page ? [{ type: "FragmentSelector", value: `page=${r.page}`, conformsTo: PDF_PAGE, refinedBy: xywh }] : [xywh];
        add({
          key: `p${++n}`,
          selector,
          quote: "",
          locator: r.page ? `p. ${r.page}` : null,
          region_png: r.png.replace(/^data:image\/png;base64,/, ""),
          preview: r.png,
          order: [r.page ?? 0, r.y, 0],
          boxes: [{ ...(r.page ? { page: r.page } : {}), x: r.x, y: r.y, w: r.w, h: r.h }],
          region: true,
        });
      };

      const save = async () => {
        const d = drafts.peek().get(k);
        if (!d?.parts.length) return;
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
        popLabel.textContent = parts ? "Add to capture" : "Capture";
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
        replace(markPop, caps.map((c) => h("button", { type: "button", title: c.title, onmousedown: (e: Event) => e.preventDefault(), onclick: () => (hideMarkPop(), shell.openRecord(c.id)) }, icon(Quote, 14), caps.length > 1 ? `Open “${c.title.slice(0, 28)}${c.title.length > 28 ? "…" : ""}”` : "Open capture")));
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
      };
      document.addEventListener("scroll", onScroll, true);
      window.addEventListener("keydown", onKey);

      // The panel beside the document.
      const panel = h("section", { class: "capture-draft", "aria-label": "New capture" });
      // Captures already made from this source (this snapshot of it), highlighted softly; kept
      // up to date as captures are made, archived or deleted.
      const saved = signal<SavedMarks[]>([]);
      let asked = 0;
      let lastSig = "";
      const stopSaved = effect(() => {
        const mine = shell.records.list(KIND).filter((c) => c.fields[F.source] === ctx.source.id);
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
      const stopPanel = effect(() => {
        const d = draftOf(k);
        const savedMarks = saved().flatMap((c) => c.parts.map((p, i) => ({ id: `${c.id}#${i}`, boxes: p.boxes, region: p.region, cfi: p.region ? undefined : (p.cfi ?? undefined), saved: true })));
        view.setMarks?.([...savedMarks, ...(d?.parts ?? []).map((p) => ({ id: p.key, boxes: p.boxes, region: p.region, cfi: p.region ? undefined : p.cfi }))]);
        if (!d?.parts.length) {
          panel.remove();
          return;
        }
        untracked(() => renderPanel(d));
        if (!panel.isConnected) ctx.aside.appendChild(panel);
      });
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
        stopSaved();
        unwatchMarks();
        window.removeEventListener("mousedown", onAway, true);
        markPop.remove();
        stopPanel();
        unwatch();
        document.removeEventListener("scroll", onScroll, true);
        window.removeEventListener("keydown", onKey);
        pop.remove();
        panel.remove();
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
  const placeOf = (anchor: Anchor | null) => (anchor?.parts[0] ? JSON.stringify(anchor.parts[0].selector) : undefined);
  /** Where to open a capture's source: its place, in the snapshot it came from. */
  const where = (anchor: Anchor | null, selector?: Selector[]): Record<string, string> => ({ place: selector ? JSON.stringify(selector) : (placeOf(anchor) ?? ""), ...(anchor?.snapshot ? { snapshot: anchor.snapshot } : {}) });
  shell.embeds.add("captures", KIND, {
    kind: KIND,
    render(r, open) {
      const quote = String(r.fields[F.quote] ?? "");
      const src = String(r.fields[F.source] ?? "");
      const cite = h("a", { href: "#", class: "embed-cite", onclick: (e: Event) => {
        e.preventDefault();
        void call<Anchor>("captures.anchor", { id: r.id }).then((a) => open(src, where(a)), () => open(src));
      } }, `— ${citation(shell, r)}`);
      const regionN = Number(r.fields["captures.parts"] ?? 0);
      const block = h("figure", { class: "embed" }, quote ? h("blockquote", { class: "embed-quote" }, quote) : null, h("figcaption", null, cite));
      if (!quote && regionN) {
        const img = h("img", { class: "capture-region", alt: "The captured region" });
        void call<string>("captures.region", { id: r.id, n: 1 }).then((src2) => (img.src = src2), () => {});
        block.prepend(img);
      }
      return block;
    },
    markdown(r) {
      const quote = String(r.fields[F.quote] ?? "[a captured region]");
      return `${quote.split("\n").map((l) => `> ${l}`).join("\n")}\n>\n> — ${citation(shell, r)}`;
    },
  });
  shell.editorExtensions.add("captures", "capture-embeds", { id: "capture-embeds", handlesEmbeds: true, extension: () => embedExtension(shell) });

  // ---- the capture page ---------------------------------------------------------------
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
          const show = () => shell.openRecord(src, where(anchor, p.selector));
          const body = quote ? h("blockquote", { class: "capture-quote" }, quote.exact) : h("img", { class: "capture-region", alt: "The captured region" });
          if (!quote) void call<string>("captures.region", { id, n: i + 1 }).then((d) => ((body as HTMLImageElement).src = d), () => {});
          const badge = s?.status === "moved" ? h("span", { class: "badge moved" }, "moved — check it") : s?.status === "lost" ? h("span", { class: "badge lost" }, "lost") : null;
          const confirm = s?.status === "moved" ? h("button", { class: "link-button", onclick: () => void confirmMoved(id, anchor, i, src).then(() => shell.router.go("capture", { id }, { replace: true })) }, "This is the place") : null;
          partsEl.appendChild(h("div", { class: "capture-part" }, body, h("div", { class: "row tight" }, h("button", { class: "link-button", onclick: show }, "Show in the source"), badge, confirm)));
        });
        const cite = h("p", { class: "muted" }, "— ", h("a", { href: "#", class: "list-link", onclick: (e: Event) => (e.preventDefault(), shell.openRecord(src, where(anchor))) }, citation(shell, r)));
        const editorHost = h("div", { class: "editor-host" });
        replace(host, h("h1", { class: "page-title" }, r.title || "Capture"), partsEl, cite, h("h2", { class: "list-heading" }, "Your words"), editorHost);
        const session = new NoteSession(id, r.version, t.body, {
          current: () => view.state.doc.toString(),
          merged: () => {},
          conflict: async () => null,
          status: (m, p) => shell.status.show(m, p ? 0 : 4000),
          saved: (seq) => void shell.records.waitFor(seq),
        });
        const view = createEditor({ parent: editorHost, doc: t.body, label: "Your words", targets: () => [], open: (x, opts) => shell.openRecord(x, {}, opts), titleOf: (x) => shell.records.get(x)?.title ?? null, onChange: () => session.changed(), onBlur: () => void session.flush(), placeholder: "Write why this matters…" });
        cleanup.push(() => (void session.close(), view.destroy()), shell.beforeClose(() => session.close()));
        ctx.setHeaderActions([h("button", { class: "icon-button", "aria-label": "Export as W3C annotations", title: "Export as W3C annotations", onclick: () => void exportW3C(shell, r, t.body) }, icon(FileDown))]);
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
    applies: (r) => r.page === "item" && !!r.params.id,
    render(host, route) {
      const src = route.params.id!;
      let alive = true;
      const stop = effect(() => {
        const list = shell.records.list(KIND).filter((c) => c.fields[F.source] === src);
        if (!list.length) return replace(host, h("p", { class: "muted" }, "Nothing captured here yet. Select a passage and choose Capture."));
        const ul = h("ul", { class: "backlinks" });
        replace(host, ul);
        for (const c of list.sort((a, b) => (a.created ?? "").localeCompare(b.created ?? ""))) {
          const status = h("span", { class: "badge" });
          const li = h("li", null, h("a", { href: "#", class: "list-link", onclick: (e: Event) => (e.preventDefault(), shell.openRecord(c.id)) }, c.title || "Capture"), " ", status, h("div", { class: "row tight" },
            h("button", { class: "link-button", onclick: () => void call<Anchor>("captures.anchor", { id: c.id }).then((a) => shell.openRecord(src, where(a))) }, "Show"),
            h("button", { class: "link-button", onclick: () => void navigator.clipboard?.writeText(`![[${c.title}|${c.id}]]`).then(() => toast("Embed copied: paste it into a note.")) }, "Copy embed")));
          ul.appendChild(li);
          void call<Anchor>("captures.anchor", { id: c.id }).then(statuses).then((s) => {
            if (!alive) return;
            const worst = s.some((x) => x.status === "lost") ? "lost" : s.some((x) => x.status === "moved") ? "moved" : "";
            status.textContent = worst === "lost" ? "lost" : worst === "moved" ? "moved" : "";
            status.className = `badge ${worst}`;
          }, () => {});
        }
      });
      return () => {
        alive = false;
        stop();
      };
    },
  });

  // Captures show under the item they were made from (in the Library's tree).
  let bySource: { from: unknown; map: Map<string, RecordInfo[]> } | null = null;
  const capturesOf = (sourceId: string): RecordInfo[] => {
    const from = shell.records.byId();
    if (bySource?.from !== from) {
      const map = new Map<string, RecordInfo[]>();
      for (const c of shell.records.list(KIND)) {
        const src = String(c.fields[F.source] ?? "");
        if (src) map.set(src, [...(map.get(src) ?? []), c]);
      }
      for (const list of map.values()) list.sort((a, b) => (a.created ?? "").localeCompare(b.created ?? ""));
      bySource = { from, map };
    }
    return bySource.map.get(sourceId) ?? [];
  };
  shell.slot<ItemChildren>(ITEM_CHILDREN).add("captures", "captures", {
    children: (item) => capturesOf(item.id).map((c) => ({ id: c.id, label: c.title || "Capture", icon: Quote, current: shell.router.current().params.id === c.id, onActivate: () => shell.openRecord(c.id) })),
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
