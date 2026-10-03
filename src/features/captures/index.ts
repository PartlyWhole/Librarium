/**
 * Captures: select a passage (or a region, in one part or several) and keep it with your own
 * words. A capture always points back to its exact place; placed in writing as
 * `![[label|id]]`, it shows as the quotation with its citation.
 */
import { call } from "../../backend";
import { h, replace } from "../../kit/dom";
import { icon } from "../../kit/icon";
import { modal } from "../../kit/dialog";
import { signal, effect } from "../../kit/signal";
import { toast } from "../../kit/toast";
import { describe, locate, locateSelection, sliceCp, toW3C, type Selector } from "../../kit/anchor";
import { createEditor } from "../../editor/editor";
import { NoteSession } from "../../editor/session";
import type { ShellApi } from "../../shell/api";
import { READER_TOOLS, type ReaderTool } from "../../shell/slots";
import type { CapturePart } from "../../generated/CapturePart";
import type { RecordInfo } from "../../generated/RecordInfo";
import type { RecordText } from "../../generated/RecordText";
import type { StoredText } from "../../generated/StoredText";
import type { Written } from "../../generated/Written";
import { embedExtension } from "./embeds";
import { Highlighter, Crop, Quote, FileDown } from "lucide";

export const KIND = "capture";
const F = { source: "captures.source", quote: "captures.quote", locator: "captures.locator" };
const PDF_PAGE = "http://tools.ietf.org/rfc/rfc8118";
const MEDIA = "http://www.w3.org/TR/media-frags/";
const CFI = "http://www.idpf.org/epub/linking/cfi/epub-cfi.html";

interface PendingPart extends CapturePart {
  preview?: string;
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
  const tray = signal<{ source: string; parts: PendingPart[] }>({ source: "", parts: [] });

  // ---- making a capture ---------------------------------------------------------------
  let part: string | undefined;
  const saveDialog = (source: RecordInfo) => {
    const parts = tray.peek().parts;
    const words = h("textarea", { class: "words-input", rows: 4, placeholder: "Your words (optional)", "aria-label": "Your words" });
    const save = async () => {
      try {
        const stored = await call<StoredText | null>("records.text", { id: source.id, part }).catch(() => null);
        const w = await call<Written>("captures.create", { source: source.id, snapshot: part ?? null, text: stored?.origin ?? null, parts: parts.map(({ preview: _p, ...x }) => x), words: words.value });
        shell.records.put(w.info, w.seq);
        tray.set({ source: "", parts: [] });
        m.close();
        toast("Captured.", { action: { label: "Open", run: () => shell.openRecord(w.info.id) } });
      } catch (e) {
        toast(String((e as { message?: string }).message ?? e));
      }
    };
    const m = modal(
      h("div", { class: "ask capture-dialog" },
        h("h2", { class: "ask-title" }, parts.length > 1 ? `Capture (${parts.length} parts)` : "Capture"),
        parts.map((p) => (p.preview ? h("img", { class: "capture-region", src: p.preview, alt: "The region" }) : h("blockquote", { class: "capture-quote" }, p.quote))),
        h("p", { class: "muted small" }, `From ${source.title}${parts[0]?.locator ? `, ${parts[0].locator}` : ""}`),
        words,
        h("div", { class: "ask-buttons" },
          h("button", { class: "button", onclick: () => m.close() }, "Add another part"),
          h("button", { class: "button", onclick: () => (tray.set({ source: "", parts: [] }), m.close()) }, "Discard"),
          h("button", { class: "button primary", onclick: () => void save() }, "Save capture"),
        ),
      ),
      { label: "Capture" },
    );
    words.focus();
  };

  const addPart = (source: RecordInfo, part: PendingPart) => {
    const t = tray.peek();
    tray.set({ source: source.id, parts: t.source === source.id ? [...t.parts, part] : [part] });
    saveDialog(source);
  };

  const tool: ReaderTool = {
    id: "capture",
    mount(toolbar, ctx) {
      part = ctx.part;
      const captureSelection = async () => {
        const sel = ctx.view.selection?.();
        if (!sel) return shell.status.show("Select some text first.");
        const stored = await call<StoredText | null>("records.text", { id: ctx.source.id, part: ctx.part }).catch(() => null);
        const seg = stored && (sel.page ? stored.segments[sel.page - 1] : sel.chapter !== undefined ? stored.segments[sel.chapter] : undefined);
        const at = stored ? locateSelection(stored.text, sel.text, seg ? { from: Number(seg.start), to: Number(seg.end) } : undefined) : null;
        const selector: Selector[] = at && stored ? [...describe(stored.text, at.start, at.end)] : [{ type: "TextQuoteSelector", exact: sel.text, prefix: "", suffix: "" }];
        if (sel.page) selector.push({ type: "FragmentSelector", value: `page=${sel.page}`, conformsTo: PDF_PAGE });
        if (sel.cfi) selector.push({ type: "FragmentSelector", value: sel.cfi, conformsTo: CFI });
        const quote = at && stored ? sliceCp(stored.text, at.start, at.end) : sel.text;
        addPart(ctx.source, { selector, quote, locator: seg?.label || (sel.page ? `p. ${sel.page}` : null), region_png: null });
        if (!at) shell.status.show("The stored text doesn’t contain that passage exactly; it was kept with its page only.", 6000);
      };
      const captureRegion = async () => {
        if (!ctx.view.pickRegion) return shell.status.show("Regions can’t be captured in this kind of item.");
        shell.status.show("Drag over the region to capture. Escape cancels.", 0);
        const r = await ctx.view.pickRegion();
        shell.status.show("");
        if (!r) return;
        const xywh = { type: "FragmentSelector" as const, value: `xywh=percent:${r.x},${r.y},${r.w},${r.h}`, conformsTo: MEDIA };
        const selector: Selector[] = r.page ? [{ type: "FragmentSelector", value: `page=${r.page}`, conformsTo: PDF_PAGE, refinedBy: xywh }] : [xywh];
        addPart(ctx.source, { selector, quote: "", locator: r.page ? `p. ${r.page}` : null, region_png: r.png.replace(/^data:image\/png;base64,/, ""), preview: r.png });
      };
      const b1 = h("button", { class: "icon-button", "aria-label": "Capture the selection", title: "Capture the selection (⇧⌘C)", onclick: () => void captureSelection() }, icon(Highlighter));
      const b2 = ctx.view.pickRegion ? h("button", { class: "icon-button", "aria-label": "Capture a region", title: "Capture a region", onclick: () => void captureRegion() }, icon(Crop)) : null;
      const pending = h("button", { class: "link-button tray", hidden: true, onclick: () => saveDialog(ctx.source) });
      toolbar.append(b1, ...(b2 ? [b2] : []), pending);
      const stop = effect(() => {
        const t = tray();
        const n = t.source === ctx.source.id ? t.parts.length : 0;
        pending.hidden = n === 0;
        pending.textContent = `${n} part${n === 1 ? "" : "s"} · Save…`;
      });
      active = captureSelection;
      return () => {
        stop();
        active = null;
        b1.remove();
        b2?.remove();
        pending.remove();
      };
    },
  };
  let active: (() => Promise<void> | void) | null = null;
  shell.slot<ReaderTool>(READER_TOOLS).add("captures", "capture", tool);
  shell.actions.add("captures", {
    id: "captures.captureSelection",
    title: "Capture the selection",
    keys: ["Mod+Shift+C"],
    when: () => shell.router.current().page === "item",
    menu: { name: "edit", group: 2 },
    icon: Highlighter,
    run: () => void active?.(),
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
        const view = createEditor({ parent: editorHost, doc: t.body, label: "Your words", targets: () => [], open: (x) => shell.openRecord(x), titleOf: (x) => shell.records.get(x)?.title ?? null, onChange: () => session.changed(), onBlur: () => void session.flush(), placeholder: "Write why this matters…" });
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

  shell.sidebar.add("captures", "captures", {
    id: "captures",
    title: "Captures",
    emptyText: "No captures yet.",
    nodes: () => shell.records.list(KIND).sort((a, b) => (b.created ?? "").localeCompare(a.created ?? "")).map((c) => ({ id: c.id, label: c.title || "Capture", icon: Quote, current: shell.router.current().params.id === c.id, onActivate: () => shell.openRecord(c.id) })),
  }, 2);

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
