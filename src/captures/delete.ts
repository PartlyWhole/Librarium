/**
 * Deleting a capture, and the menu that offers it. A capture nothing uses goes to the archive
 * at once. One that notes use first asks, place by place, what happens there: keep it as text
 * (the default: nothing is lost), remove it, or leave it. Then each note is rewritten and the
 * capture archived; one Undo puts all of it back, in the place's history it was deleted from.
 */
import { call } from "../backend";
import { archiveRecords } from "../archive";
import { openRecord } from "../app/records";
import { done, LIBRARY } from "../app/undo";
import { modal } from "../ui/dialog";
import { errorText, h, uniqueId } from "../ui/dom";
import { count } from "../ui/format";
import { contextMenu, type Point } from "../ui/menu";
import { toast } from "../ui/toast";
import type { RecordInfo, RecordText, SaveResult } from "../types";
import { citation, copyEmbed, quoteOf, showInSource } from "./common";
import { findReferences, referencesIn, rewriteAll, type AsText, type Choice, type Reference } from "./references";

const CHOICES: Record<"embed" | "link", [Choice, string][]> = {
  embed: [["text", "Keep as quoted text"], ["remove", "Remove"], ["leave", "Leave in place"]],
  link: [["text", "Keep the words"], ["remove", "Remove"], ["leave", "Leave the link"]],
};

const shorten = (s: string, n = 90) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

/** What a place will become, in words. */
function outcome(r: Reference, choice: Choice, asText: AsText): string {
  if (r.source.read_only) return "This file is read-only, so it stays as it is.";
  if (choice === "leave") return r.link.embed ? "Stays as written: shown as its source, ![[…]], until you restore the capture." : "Stays a link, to the capture in the archive.";
  if (choice === "remove") return r.alone ? "The line is taken out." : "Taken out of the sentence.";
  if (!r.link.embed) return `Becomes the plain words “${shorten(r.link.label, 60)}”.`;
  const q = asText.quote ? `“${shorten(asText.quote.replace(/\s+/g, " "), 70)}”` : "a note that a picture was here";
  return r.alone ? `Becomes a written quotation: ${q} — ${asText.cite}.` : `Becomes ${q} (${asText.cite}) in the sentence.`;
}

/** Asks what happens to each place; resolves with a choice per reference, or null on Cancel. */
function choose(c: RecordInfo, refs: Reference[], asText: AsText): Promise<Choice[] | null> {
  return new Promise((resolve) => {
    const choices: Choice[] = refs.map((r) => (r.source.read_only ? "leave" : "text"));
    let result: Choice[] | null = null;
    const sources = [...new Map(refs.map((r) => [r.source.id, r.source])).values()];
    const go = h("button", { class: "button destructive", onclick: () => ((result = choices), m.close()) });
    const radios: HTMLInputElement[][] = [];
    const afters: HTMLElement[] = [];
    const update = () => {
      refs.forEach((r, i) => {
        radios[i]!.forEach((x) => (x.checked = x.value === choices[i]));
        afters[i]!.textContent = outcome(r, choices[i]!, asText);
      });
      const changed = new Set(refs.filter((_, i) => choices[i] !== "leave").map((r) => r.source.id)).size;
      go.textContent = changed ? `Delete and update ${count(changed, "note")}` : "Delete";
    };
    const setAll = (v: Choice) => {
      refs.forEach((r, i) => !r.source.read_only && (choices[i] = v));
      update();
    };
    const row = (r: Reference, i: number) => {
      const name = uniqueId("ref");
      radios[i] = [];
      const opts = CHOICES[r.link.embed ? "embed" : "link"].map(([v, label]) => {
        const input = h("input", { type: "radio", name, value: v, disabled: r.source.read_only || undefined, onchange: () => ((choices[i] = v), update()) });
        radios[i]!.push(input);
        return h("label", { class: "ref-option" }, input, h("span", null, label));
      });
      afters[i] = h("p", { class: "ref-after muted small", "aria-live": "polite" });
      const here = r.link.embed
        ? h("div", { class: "ref-here ref-embed" }, `“${shorten(asText.quote || r.link.label, 120)}”`)
        : h("div", { class: "ref-here" }, shorten(r.line, 120).split(r.link.label).flatMap((part, k, all) => (k < all.length - 1 ? [part, h("mark", { class: "ref-link" }, r.link.label)] : [part])));
      return h("li", { class: "ref-row" },
        r.before ? h("div", { class: "ref-before muted small" }, shorten(r.before)) : null,
        here,
        h("fieldset", { class: "ref-choice" }, h("legend", { class: "visually-hidden" }, `What happens to it in “${r.source.title || "Untitled"}”`), opts),
        afters[i]);
    };
    const titleId = uniqueId("dlg-title");
    const body = h("div", { class: "ask delete-refs" },
      h("h2", { id: titleId, class: "ask-title" }, `Delete “${c.title || "Capture"}”?`),
      h("div", { class: "ask-body" },
        h("p", null, refs.length === 1 ? `It’s used in “${sources[0]!.title || "Untitled"}”. Choose what happens there.` : `It’s used in ${count(refs.length, "place")} in ${count(sources.length, "note")}. Choose what happens to each.`),
        refs.length > 1 ? h("div", { class: "refs-all small" }, h("span", { class: "muted" }, "For every place:"),
          h("button", { type: "button", class: "link-button", onclick: () => setAll("text") }, "Keep as text"),
          h("button", { type: "button", class: "link-button", onclick: () => setAll("remove") }, "Remove"),
          h("button", { type: "button", class: "link-button", onclick: () => setAll("leave") }, "Leave")) : null,
        h("div", { class: "refs-list" }, sources.map((s) =>
          h("section", { class: "ref-source", "aria-label": s.title || "Untitled" },
            h("h3", { class: "ref-source-title" }, s.title || "Untitled", s.kind === "capture" ? h("span", { class: "muted small" }, " · a capture’s words") : null),
            h("ul", { class: "ref-rows" }, refs.map((r, i) => (r.source.id === s.id ? row(r, i) : null)))))),
        h("p", { class: "muted small" }, "The capture goes to the archive. Undo puts back the capture and every note changed here.")),
      h("div", { class: "ask-buttons" }, h("button", { class: "button", onclick: () => m.close() }, "Cancel"), go));
    const m = modal(body, { label: "Delete capture", className: "wide", onClose: () => resolve(result) });
    m.el.setAttribute("aria-labelledby", titleId);
    m.el.removeAttribute("aria-label");
    update();
    (radios.flat().find((x) => x.checked && !x.disabled) ?? go).focus();
  });
}

/** A note rewritten: its text before and after, and the version the last write made. */
interface Step {
  id: string;
  title: string;
  before: string;
  after: string;
  version: string;
}

/** Saves `to` over `from` (merging with anything typed since); throws if it can't. */
async function put(s: Step, from: string, to: string): Promise<void> {
  const r = await call<SaveResult>("records.save", { id: s.id, base_version: s.version, base_body: from, body: to });
  if (r.outcome === "conflict") throw new Error(`“${s.title}” has changed in the same place since, so it was left as it is.`);
  s.version = r.version;
}

/** Rewrites each note as chosen; a note that changed meanwhile is left as it is. */
async function rewriteNotes(c: RecordInfo, refs: Reference[], choices: Choice[], asText: AsText): Promise<Step[]> {
  const steps: Step[] = [];
  for (const id of new Set(refs.map((r) => r.source.id))) {
    const chosen = refs.map((r, i) => ({ r, choice: choices[i]! })).filter((x) => x.r.source.id === id);
    if (chosen.every((x) => x.choice === "leave")) continue;
    const title = chosen[0]!.r.source.title || "Untitled";
    try {
      const t = await call<RecordText>("records.read", { id });
      const now = referencesIn(t.info, t.body, c.id);
      if (now.length !== chosen.length) throw new Error(`“${title}” changed while you were choosing, so it was left as it is.`);
      const step: Step = { id, title, before: t.body, after: rewriteAll(t.body, now.map((r, k) => ({ link: r.link, choice: chosen[k]!.choice })), asText), version: t.info.version };
      await put(step, step.before, step.after);
      steps.push(step);
    } catch (e) {
      toast(errorText(e) || `“${title}” couldn’t be changed.`);
    }
  }
  return steps;
}

/**
 * Deletes a capture (to the archive), asking first about the notes that use it. Its Undo
 * belongs to `scope`: the capture's page, its source's, or the Library's. Resolves true when
 * it was deleted.
 */
export async function deleteCapture(c: RecordInfo, scope = LIBRARY): Promise<boolean> {
  if (c.read_only) {
    toast("This capture can’t be deleted: its file is read-only.");
    return false;
  }
  const asText: AsText = { quote: quoteOf(c), cite: citation(c) };
  const refs = await findReferences(c.id);
  const choices = refs.length ? await choose(c, refs, asText) : [];
  if (!choices) return false;
  const steps = await rewriteNotes(c, refs, choices, asText);
  const a = await archiveRecords([c.id]);
  if (!a.archived) {
    // Not archived: the notes go back as they were.
    for (const s of steps) await put(s, s.after, s.before).catch(() => {});
    return false;
  }
  const what = `“${c.title || "Capture"}”`;
  done(steps.length ? `Deleted ${what} and updated ${count(steps.length, "note")}` : `Deleted ${what}`, {
    label: `delete ${what}`,
    undo: async () => {
      await a.undo();
      for (const s of steps) await put(s, s.after, s.before);
    },
    redo: async () => {
      for (const s of steps) await put(s, s.before, s.after);
      await a.redo();
    },
  }, scope);
  return true;
}

/** A capture's context menu, wherever it is listed. */
export function captureMenu(c: RecordInfo, at: Point, scope = LIBRARY): void {
  contextMenu([
    { label: "Open", run: () => openRecord(c.id) },
    { label: "Show in the source", run: () => showInSource(c) },
    { label: "Copy embed", run: () => copyEmbed(c) },
    "separator",
    { label: "Delete", destructive: true, run: () => void deleteCapture(c, scope) },
  ], at, c.title || "Capture");
}
