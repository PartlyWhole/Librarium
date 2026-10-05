/**
 * Deleting a capture that is used somewhere (decision 0059). A dialog lists each place, grouped
 * by note, with what is around it, and asks what happens there: keep it as text (the default:
 * nothing is lost), remove it, or leave it (it shows as its source until restored). Each
 * choice says what the place will become. On Delete, each note is rewritten (merged with any
 * unsaved typing, as for any outside edit) and the capture goes to the archive; one Undo puts
 * all of it back.
 */
import { call } from "../../backend";
import { h, uniqueId } from "../../kit/dom";
import { modal } from "../../kit/dialog";
import { count } from "../../kit/format";
import { toast } from "../../kit/toast";
import { ARCHIVER, type Archiver, type ShellApi } from "../../shell/slots";
import type { RecordInfo } from "../../generated/RecordInfo";
import type { RecordText } from "../../generated/RecordText";
import type { SaveResult } from "../../generated/SaveResult";
import { findReferences, referencesIn, rewriteAll, type AsText, type Choice, type Reference } from "./references";

const CHOICES: Record<"embed" | "link", [Choice, string][]> = {
  embed: [["text", "Keep as quoted text"], ["remove", "Remove"], ["leave", "Leave in place"]],
  link: [["text", "Keep the words"], ["remove", "Remove"], ["leave", "Leave the link"]],
};

const shorten = (s: string, n = 90) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

/** What a place will become, in words. */
function outcome(r: Reference, choice: Choice, asText: AsText): string {
  const alone = r.alone;
  if (choice === "leave") return r.link.embed ? "Stays as written: shown as its source, ![[…]], until you restore the capture." : "Stays a link, to the capture in the archive.";
  if (choice === "remove") return alone ? "The line is taken out." : "Taken out of the sentence.";
  if (!r.link.embed) return `Becomes the plain words “${shorten(r.link.label, 60)}”.`;
  const q = asText.quote ? `“${shorten(asText.quote.replace(/\s+/g, " "), 70)}”` : "a note that a picture was here";
  return alone ? `Becomes a written quotation: ${q} — ${asText.cite}.` : `Becomes ${q} (${asText.cite}) in the sentence.`;
}

/** Asks what happens to each place; resolves with a choice per reference, or null on Cancel. */
function choose(c: RecordInfo, refs: Reference[], asText: AsText): Promise<Choice[] | null> {
  return new Promise((resolve) => {
    const choices: Choice[] = refs.map((r) => (r.source.read_only ? "leave" : "text"));
    let result: Choice[] | null = null;
    const titleId = uniqueId("dlg-title");
    const sources = [...new Map(refs.map((r) => [r.source.id, r.source])).values()];
    const go = h("button", { class: "button destructive", onclick: () => ((result = choices), m.close()) });
    const radios: HTMLInputElement[][] = [];
    const afters: HTMLElement[] = [];
    const update = () => {
      refs.forEach((r, i) => {
        radios[i]?.forEach((x) => (x.checked = x.value === choices[i]));
        afters[i]!.textContent = r.source.read_only ? "This file is read-only, so it stays as it is." : outcome(r, choices[i]!, asText);
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
      const kind = r.link.embed ? "embed" : "link";
      const opts = CHOICES[kind].map(([v, label]) => {
        const input = h("input", { type: "radio", name, value: v, disabled: r.source.read_only || undefined, onchange: () => ((choices[i] = v), update()) }) as HTMLInputElement;
        return { input, el: h("label", { class: "ref-option" }, input, h("span", null, label)) };
      });
      radios[i] = opts.map((o) => o.input);
      const after = h("p", { class: "ref-after muted small", "aria-live": "polite" });
      afters[i] = after;
      const here = r.link.embed
        ? h("div", { class: "ref-here ref-embed" }, `“${shorten(asText.quote || r.link.label, 120)}”`)
        : h("div", { class: "ref-here" }, shorten(r.line, 120).split(r.link.label).flatMap((part, k, all) => (k < all.length - 1 ? [part, h("mark", { class: "ref-link" }, r.link.label)] : [part])));
      return h("li", { class: "ref-row" },
        r.before ? h("div", { class: "ref-before muted small" }, shorten(r.before)) : null,
        here,
        h("fieldset", { class: "ref-choice" }, h("legend", { class: "visually-hidden" }, `What happens to it in “${r.source.title || "Untitled"}”`), opts.map((o) => o.el)),
        after);
    };
    const places = count(refs.length, "place");
    const body = h("div", { class: "ask delete-refs" },
      h("h2", { id: titleId, class: "ask-title" }, `Delete “${c.title || "Capture"}”?`),
      h("div", { class: "ask-body" },
        h("p", null, refs.length === 1 ? `It’s used in “${sources[0]!.title || "Untitled"}”. Choose what happens there.` : `It’s used in ${places} in ${count(sources.length, "note")}. Choose what happens to each.`),
        refs.length > 1 ? h("div", { class: "refs-all small" }, h("span", { class: "muted" }, "For every place:"),
          h("button", { type: "button", class: "link-button", onclick: () => setAll("text") }, "Keep as text"),
          h("button", { type: "button", class: "link-button", onclick: () => setAll("remove") }, "Remove"),
          h("button", { type: "button", class: "link-button", onclick: () => setAll("leave") }, "Leave")) : null,
        h("div", { class: "refs-list" }, sources.map((s) =>
          h("section", { class: "ref-source", "aria-label": s.title || "Untitled" },
            h("h3", { class: "ref-source-title" }, s.title || "Untitled", s.kind === "note" ? null : h("span", { class: "muted small" }, ` · ${s.kind === "capture" ? "a capture’s words" : s.kind}`)),
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

interface Step {
  id: string;
  title: string;
  before: string;
  after: string;
  version: string;
}

/** Saves `to` over `from` (merging with anything typed since); throws if it can't. */
async function put(shell: ShellApi, s: Step, version: string, from: string, to: string): Promise<string> {
  const r = await call<SaveResult>("records.save", { id: s.id, base_version: version, base_body: from, body: to });
  if (r.outcome === "conflict") throw new Error(`“${s.title}” has changed in the same place since, so it was left as it is.`);
  void shell.records.waitFor(r.seq);
  return r.version;
}

/**
 * Deletes a capture: straight to the archive when nothing uses it (`plain`), otherwise after
 * the user has chosen what happens to each place. Resolves true when it was deleted.
 */
export async function deleteCapture(shell: ShellApi, c: RecordInfo, asText: AsText, plain: () => Promise<boolean>, scope: string): Promise<boolean> {
  const refs = await findReferences(c.id, shell.records);
  if (!refs.length) return plain();
  const archiver = shell.slot<Archiver>(ARCHIVER).values()[0];
  if (!archiver) {
    shell.status.show("This capture can’t be deleted here.");
    return false;
  }
  const choices = await choose(c, refs, asText);
  if (!choices) return false;
  // Each note is read again and changed as chosen; one that changed in between is left.
  const steps: Step[] = [];
  for (const id of [...new Set(refs.map((r) => r.source.id))]) {
    const chosen = refs.map((r, i) => ({ r, choice: choices[i]! })).filter((x) => x.r.source.id === id);
    if (chosen.every((x) => x.choice === "leave")) continue;
    const title = chosen[0]!.r.source.title || "Untitled";
    try {
      const t = await call<RecordText>("records.read", { id });
      const now = referencesIn(t.info, t.body, c.id);
      if (now.length !== chosen.length) throw new Error(`“${title}” changed while you were choosing, so it was left as it is.`);
      const after = rewriteAll(t.body, now.map((r, k) => ({ link: r.link, choice: chosen[k]!.choice })), asText);
      const step: Step = { id, title, before: t.body, after, version: "" };
      step.version = await put(shell, step, t.info.version, t.body, after);
      steps.push(step);
    } catch (e) {
      toast(e instanceof Error ? e.message : `“${title}” couldn’t be changed.`);
    }
  }
  const a = await archiver.archive([c.id]);
  if (!a.archived) {
    // Not archived: put the notes back as they were.
    for (const s of steps) await put(shell, s, s.version, s.after, s.before).catch(() => {});
    return false;
  }
  const what = `“${c.title || "Capture"}”`;
  shell.undo.done(steps.length ? `Deleted ${what} and updated ${count(steps.length, "note")}` : `Deleted ${what}`, {
    label: `delete ${what}`,
    undo: async () => {
      await a.undo();
      for (const s of steps) s.version = await put(shell, s, s.version, s.after, s.before);
    },
    redo: async () => {
      for (const s of steps) s.version = await put(shell, s, s.version, s.before, s.after);
      await a.redo();
    },
  }, { scope });
  return true;
}
