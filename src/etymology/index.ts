/**
 * Word origins: the side panel's Word origins view. A word typed there, or selected in a note,
 * a PDF or a saved page (Look up word origin, ⌃⌘E), shows its line of descent, Wiktionary's
 * account, its doublets and cognates, and the English words it shares ancestors with; any word
 * shown opens in turn (Back returns). Beside a note, Insert puts the line of descent into it as
 * a quotation with its source. Capture captures it (or, selected, any words of an entry), citing
 * the Word origins library item, whose own page is this view. The data is downloaded once, when
 * asked (see etymology.rs).
 */
import { call } from "../backend";
import { dataStatus, datasetSetup } from "../app/dataset";
import { defineAction } from "../app/actions";
import { addPanelView, showPanelView } from "../app/panel";
import type { PageContext } from "../app/pages";
import { formatOf } from "../app/records";
import { router } from "../app/router";
import { ETYM_TERM } from "../captures/anchor";
import { anchorOf } from "../captures/common";
import { captureReference, captureSelections, dataItem, selectedWords } from "../captures/quick";
import { activeEditor } from "../notes/editor/editor";
import { noteView } from "../notes/page";
import { errorText, h, replace } from "../ui/dom";
import { iconButton } from "../ui/icon";
import { effect, signal } from "../ui/signal";
import type { EtymEntry, EtymLookup, EtymTerm, RecordInfo } from "../types";
import "./etymology.css";
import { ArrowLeft, Highlighter, Sprout, TextCursorInput } from "lucide";

const status = dataStatus("etymology");

/** What is shown: a word (looked up) or a term (by key), and what was shown before it. */
type Shown = { word: string } | { key: string };
const shown = signal<Shown | null>(null);
const back: Shown[] = [];

function show(next: Shown, remember = true, panel = true): void {
  const cur = shown.peek();
  if (remember && cur) back.push(cur);
  shown.set(next);
  if (panel && router.current.peek().page !== "item") showPanelView("etymology");
}

/** The word selected (in a note, or in a PDF or saved page), or the one at a note's cursor. */
function selectedWord(): string {
  const v = activeEditor();
  if (v) {
    const sel = v.state.selection.main;
    if (!sel.empty) return v.state.sliceDoc(sel.from, sel.to);
    const word = v.state.wordAt(sel.head);
    if (word) return v.state.sliceDoc(word.from, word.to);
  }
  return window.getSelection()?.toString() ?? "";
}

defineAction({
  id: "etymology.lookup",
  title: "Look up word origin",
  keys: ["Mod+Ctrl+E"],
  // In a note, too.
  reserved: true,
  run: () => {
    const word = selectedWord().trim();
    if (word && word.split(/\s+/).length <= 3) show({ word });
    else showPanelView("etymology");
  },
  menu: { name: "edit", group: 2.95 },
  icon: Sprout,
});

/** A word that opens when clicked. */
const termLink = (t: EtymTerm, label = t.term) =>
  h("a", { href: "#", class: "etym-term", title: [t.lang_name, t.gloss].filter(Boolean).join(": "), onclick: (e: MouseEvent) => (e.preventDefault(), show(t.lang === "en" ? { word: t.term } : { key: t.key })) }, label);

// Italics are written with `_`, so a reconstruction's `*` needs no escaping (and shows as written).
const escapeMd = (s: string) => s.replace(/[\\_`[\]]/g, (c) => `\\${c}`);

/** A word's entry as Insert puts it in a note: its top, as the view shows it, in Markdown. */
function lineageMarkdown(e: EtymEntry): string {
  const head = `**${escapeMd(e.term.lang === "en" ? e.term.term : `${e.term.lang_name} ${e.term.term}`)}**${e.pos ? ` _${escapeMd(e.pos)}_` : ""}`;
  const senses = e.senses.length ? e.senses.slice(0, 2).map((s, i) => `${i + 1}. ${escapeMd(s.gloss)}`).join("\n") : e.term.gloss ? escapeMd(e.term.gloss) : "";
  const steps = e.lineage.slice(1).map((s) => `- ${s.term.lang_name} _${escapeMd(s.term.term)}_${s.with.length ? ` + ${s.with.map(escapeMd).join(" + ")}` : ""}${s.term.gloss ? ` “${escapeMd(s.term.gloss)}”` : ""}${s.rel ? ` (${s.rel})` : ""}`).join("\n");
  return [head, senses, "**Line of descent**", steps, "_— Word origins from Wiktionary (CC BY-SA 4.0) and other dictionaries_"].filter(Boolean).join("\n\n");
}

/** Captures words of a word's entry (its line of descent, unless others are given), citing the
 * Word origins item and the word. */
function captureEntry(term: { key: string; term: string; lang: string; lang_name: string }, quote: string, whole = false): Promise<void> {
  const locator = term.lang === "en" ? term.term : `${term.lang_name} ${term.term}`;
  return captureReference({
    source: () => dataItem((r) => formatOf(r) === "etymology", "etymology.record"),
    quote,
    ref: { value: term.key, conformsTo: ETYM_TERM },
    locator,
    label: `the origins of “${locator}”`,
    // A whole entry is named for its word (its words begin with the word anyway).
    ...(whole ? { title: `Origins of ${locator}` } : {}),
  });
}

/** Words selected in one entry, to capture: across more than one part of its top (the word, its
 * meanings, its line of descent), the entry itself; else the words, a paragraph to a block. */
function selectedInEntry(range: Range): { term: { key: string; term: string; lang: string; lang_name: string }; quote: string; whole: boolean } | null {
  const el = (n: Node) => (n instanceof Element ? n : n.parentElement);
  const a = el(range.startContainer)?.closest<HTMLElement>(".etym-entry");
  if (!a || a !== el(range.endContainer)?.closest(".etym-entry")) return null;
  const d = a.dataset;
  const term = { key: d.key!, term: d.term!, lang: d.lang!, lang_name: d.langName! };
  const touched = [...a.children].filter((c) => rangeHas(range, c));
  const entry = shownEntries.get(a);
  if (entry && touched.length > 1 && touched.every((c) => c instanceof HTMLElement && c.dataset.part)) return { term, quote: entryText(entry), whole: true };
  const quote = selectedWords(range, "button", true);
  return quote ? { term, quote, whole: false } : null;
}

/** Whether a range takes some of an element's words (not only its edge). */
function rangeHas(range: Range, el: Element): boolean {
  const r = document.createRange();
  r.selectNodeContents(el);
  if (range.compareBoundaryPoints(Range.END_TO_START, r) >= 0 || range.compareBoundaryPoints(Range.START_TO_END, r) <= 0) return false;
  const inside = range.cloneRange();
  if (inside.compareBoundaryPoints(Range.START_TO_START, r) < 0) inside.setStart(r.startContainer, r.startOffset);
  if (inside.compareBoundaryPoints(Range.END_TO_END, r) > 0) inside.setEnd(r.endContainer, r.endOffset);
  return !!inside.toString().trim();
}

/** Puts a block into a note at its cursor, on lines of its own. */
function insertInto(noteId: string, text: string): void {
  const view = noteView(noteId);
  if (!view) return;
  const at = view.state.selection.main;
  const line = view.state.doc.lineAt(at.head);
  const before = line.text.trim() ? "\n\n" : "";
  const pos = line.text.trim() ? line.to : line.from;
  view.dispatch({ changes: { from: pos, insert: `${before}${text}\n\n` }, selection: { anchor: pos + before.length + text.length + 2 }, userEvent: "input.etymology", scrollIntoView: true });
  view.focus();
}

const section = (title: string, ...body: (Node | null)[]) => h("section", { class: "etym-section" }, h("h3", null, title), ...body);

/** An entry's top, as the view shows it and its captures are drawn: the word, its first
 * meanings and its line of descent (each word through `word`: a link here, plain in a capture). */
function entryTop(e: EtymEntry, word: (t: EtymTerm) => Node, actions: Node | null = null): Node[] {
  const steps = e.lineage.slice(1);
  return [
    h("div", { class: "etym-head", dataset: { part: "head" } },
      h("h2", null, e.term.term), h("span", { class: "muted small" }, [e.term.lang !== "en" ? e.term.lang_name : null, e.pos].filter(Boolean).join(" · ")), actions),
    e.senses.length
      ? h("ol", { class: "etym-senses small", dataset: { part: "senses" } }, e.senses.slice(0, 2).map((s) => h("li", null, s.gloss)))
      : e.term.gloss ? h("p", { class: "small", dataset: { part: "senses" } }, e.term.gloss) : null,
    steps.length
      ? h("section", { class: "etym-section", dataset: { part: "line" } }, h("h3", null, "Line of descent"),
          h("ol", { class: "etym-line" }, steps.map((s) =>
            h("li", null, h("span", { class: "muted small" }, s.term.lang_name), " ", word(s.term),
              s.with.length ? h("span", { class: "muted small" }, ` + ${s.with.join(" + ")}`) : null,
              s.term.gloss ? h("span", { class: "muted small" }, ` “${s.term.gloss}”`) : null,
              s.rel ? h("span", { class: "etym-rel small" }, s.rel) : null))))
      : null,
  ].filter((x): x is HTMLElement => !!x);
}

/** An entry's top as text, as a capture of it holds it (and lists and search show it). */
function entryText(e: EtymEntry): string {
  const head = `${e.term.lang === "en" ? e.term.term : `${e.term.lang_name} ${e.term.term}`}${e.pos ? ` (${e.pos})` : ""}`;
  const senses = e.senses.length ? e.senses.slice(0, 2).map((s, i) => `${i + 1}. ${s.gloss}`) : e.term.gloss ? [e.term.gloss] : [];
  const steps = e.lineage.slice(1).map((s) => `${s.term.lang_name} ${s.term.term}${s.with.length ? ` + ${s.with.join(" + ")}` : ""}${s.term.gloss ? ` “${s.term.gloss}”` : ""}${s.rel ? ` (${s.rel})` : ""}`);
  return [head, ...senses, ...(steps.length ? ["Line of descent", ...steps] : [])].join("\n\n");
}

/** Each entry shown, by its element (a selection in it may capture it whole). */
const shownEntries = new WeakMap<HTMLElement, EtymEntry>();

/** A capture of a word's entry drawn as the view shows it, if it is one (its words are the
 * entry's top as text); else null, and its quotation is shown. */
export async function entryCapture(c: RecordInfo): Promise<HTMLElement | null> {
  const key = (await anchorOf(c.id)).parts[0]?.selector.find((x) => "conformsTo" in x && x.conformsTo === ETYM_TERM) as { value?: string } | undefined;
  if (!key?.value) return null;
  const e = (await call<EtymLookup>("etymology.term", { key: key.value })).entries.find((x) => x.term.key === key.value);
  if (!e || entryText(e) !== String(c.fields["captures.quote"] ?? "").trim()) return null;
  return h("div", { class: "etym-card" }, entryTop(e, (t) => h("span", { class: "etym-term" }, t.term)));
}

function entryView(e: EtymEntry, noteId: string | null): HTMLElement {
  const steps = e.lineage.slice(1);
  const chips = (ts: EtymTerm[]) => h("div", { class: "etym-chips" }, ts.map((t) => termLink(t)));
  const actions = h("span", { class: "etym-actions" },
    iconButton(Highlighter, "Capture this word’s entry (or select words to capture them)", () => void captureEntry(e.term, entryText(e), true), undefined, 15),
    noteId && steps.length ? iconButton(TextCursorInput, "Insert into the note", () => insertInto(noteId, lineageMarkdown(e)), undefined, 15) : null);
  const el = h("article", { class: "etym-entry", dataset: { key: e.term.key, term: e.term.term, lang: e.term.lang, langName: e.term.lang_name } },
    ...entryTop(e, (t) => termLink(t), actions),
    steps.length ? null : h("p", { class: "muted small" }, e.senses.length || e.term.gloss ? "No origin is recorded for this word." : "No origin is recorded for this word. If it is a form of another word (wrote, mice), try that word."),
    e.etymology ? section("From Wiktionary", h("p", { class: "etym-prose small" }, e.etymology)) : null,
    e.doublets.length ? section("Doublets", chips(e.doublets)) : null,
    e.relatives.length
      ? section("Related English words", ...e.relatives.map((r) =>
          h("div", { class: "etym-relatives" },
            h("div", { class: "muted small" }, "From ", r.ancestor.lang_name, " ", termLink(r.ancestor), r.total > r.words.length ? ` (${r.total})` : ""),
            chips(r.words))))
      : null,
    e.descendants.length ? section("English words from it", chips(e.descendants)) : null,
    e.cognates.length ? section("Cognates", chips(e.cognates)) : null,
    e.roots.length ? section("Roots", chips(e.roots)) : null);
  shownEntries.set(el, e);
  return el;
}

/** The view (in the side panel, or the Word origins item's page); `noteId`: the note beside it. */
function etymologyView(host: HTMLElement, noteId: string | null): () => void {
  const input = h("input", { class: "search-input", type: "search", placeholder: "Look up a word", "aria-label": "Look up a word", spellcheck: false });
  const suggest = h("div", { class: "etym-suggest", role: "listbox", hidden: true });
  const result = h("div", { class: "etym-result", "aria-live": "polite" });
  const backButton = iconButton(ArrowLeft, "Back", () => {
    const prev = back.pop();
    if (prev) show(prev, false);
  }, undefined, 15);
  const form = h("form", { class: "etym-form", onsubmit: (e: Event) => (e.preventDefault(), input.value.trim() && show({ word: input.value.trim() })) }, backButton, input);
  let timer: ReturnType<typeof setTimeout> | undefined;
  input.addEventListener("input", () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (!q) return void (suggest.hidden = true);
    timer = setTimeout(() => void call<EtymTerm[]>("etymology.search", { word: q }).then((ts) => {
      replace(suggest, ts.map((t) => h("button", { type: "button", role: "option", class: "etym-suggestion", onclick: () => ((suggest.hidden = true), show({ word: t.term })) }, h("span", null, t.term), t.gloss ? h("span", { class: "muted small" }, t.gloss) : null)));
      suggest.hidden = !ts.length || document.activeElement !== input;
    }, () => {}), 150);
  });
  input.addEventListener("blur", () => setTimeout(() => (suggest.hidden = true), 150));
  let asked = 0;
  const stop = effect(() => {
    const s = status();
    const what = shown();
    backButton.style.display = back.length ? "" : "none";
    if (!s) return replace(host);
    if (s.state !== "ready") return replace(host, h("div", { class: "etym-panel" }, datasetSetup("etymology", s, { name: "word origins", about: "Where English words come from: each word’s line of descent back through Middle English, French, Latin, Greek and Proto-Indo-European, and the words it is related to. From Wiktionary and other dictionaries, kept on this Mac." })));
    replace(host, h("div", { class: "etym-panel" }, form, suggest, result));
    if (!what) return replace(result, h("p", { class: "muted small" }, "Type a word, or select one in a note or a page and choose Look up word origin (⌃⌘E)."));
    if ("word" in what) input.value = what.word;
    const ask = ++asked;
    replace(result, h("p", { class: "muted small" }, "Looking it up…"));
    void call<EtymLookup>("word" in what ? "etymology.lookup" : "etymology.term", "word" in what ? { word: what.word } : { key: what.key }).then((l) => {
      if (ask !== asked) return;
      if (!l.entries.length) {
        return replace(result, h("p", { class: "small" }, `“${l.query}” isn’t in the word origins.`),
          l.suggestions.length ? h("div", { class: "etym-chips" }, l.suggestions.map((t) => termLink(t))) : null);
      }
      if (!input.value) input.value = l.entries[0]!.term.term;
      // The sources, as their licences ask, folded under a line.
      replace(result, ...l.entries.map((e) => entryView(e, noteId && router.current.peek().params.id === noteId ? noteId : null)),
        h("details", { class: "etym-attribution muted" }, h("summary", null, "From Wiktionary (CC BY-SA 4.0) and other dictionaries"), h("p", null, l.attribution)));
    }, (e) => ask === asked && replace(result, h("p", { class: "small" }, errorText(e))));
  });
  const stopCapture = captureSelections(host, selectedInEntry, (p) => void captureEntry(p.term, p.quote, p.whole));
  return () => {
    clearTimeout(timer);
    stop();
    stopCapture();
  };
}

addPanelView({
  id: "etymology",
  title: "Word origins",
  icon: Sprout,
  applies: () => true,
  render: (host, route) => etymologyView(host, route.page === "note" ? (route.params.id ?? null) : null),
});

/** The Word origins item's page: the view, at the word a capture's place names. */
export function renderEtymologyItem(host: HTMLElement, params: Record<string, string>, ctx: PageContext): () => void {
  ctx.setTitle("Word origins");
  host.classList.add("etym-page");
  try {
    const key = (JSON.parse(params.place ?? "[]") as { conformsTo?: string; value?: string }[]).find((x) => x.conformsTo === ETYM_TERM)?.value;
    if (key) show({ key }, true, false);
  } catch {
    /* no place */
  }
  const stop = etymologyView(host, null);
  return () => (stop(), host.classList.remove("etym-page"));
}
