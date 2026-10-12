/**
 * Word origins: the side panel's Word origins view. A word typed there, or selected in a note,
 * a PDF or a saved page (Look up word origin, ⌃⌘E), shows its line of descent, Wiktionary's
 * account, its doublets and cognates, and the English words it shares ancestors with; any word
 * shown opens in turn (Back returns). Beside a note, Insert puts the line of descent into it as
 * a quotation with its source. The data is downloaded once, when asked (see etymology.rs).
 */
import { call, on } from "../backend";
import { defineAction } from "../app/actions";
import { addPanelView, showPanelView } from "../app/panel";
import { router } from "../app/router";
import { activeEditor } from "../notes/editor/editor";
import { noteView } from "../notes/page";
import { errorText, h, replace } from "../ui/dom";
import { icon, iconButton } from "../ui/icon";
import { effect, signal } from "../ui/signal";
import { toast } from "../ui/toast";
import type { EtymEntry, EtymLookup, EtymStatus, EtymTerm } from "../types";
import "./etymology.css";
import { ArrowLeft, Download, Sprout, TextCursorInput } from "lucide";

const status = signal<EtymStatus | null>(null);
void call<EtymStatus>("etymology.status").then((s) => status.set(s), () => {});
on<EtymStatus>("etymology.status", (s) => status.set(s));

/** What is shown: a word (looked up) or a term (by key), and what was shown before it. */
type Shown = { word: string } | { key: string };
const shown = signal<Shown | null>(null);
const back: Shown[] = [];

function show(next: Shown, remember = true): void {
  const cur = shown.peek();
  if (remember && cur) back.push(cur);
  shown.set(next);
  showPanelView("etymology");
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

const mb = (n: number) => `${Math.round(n / 1_000_000)} MB`;

/** Download, its progress, or why it failed. */
function setup(s: EtymStatus): HTMLElement {
  const about = h("p", { class: "muted small" }, "Where English words come from: each word’s line of descent back through Middle English, French, Latin, Greek and Proto-Indo-European, and the words it is related to. From Wiktionary and other dictionaries, kept on this Mac.");
  if (s.state === "downloading" || s.state === "unpacking") {
    const done = s.state === "unpacking" ? 1 : s.received / s.download_bytes;
    return h("div", { class: "etym-setup" }, about,
      h("progress", { class: "etym-progress", max: "1", value: String(done) }),
      h("p", { class: "small" }, s.state === "unpacking" ? "Unpacking and checking…" : `Downloading word origins: ${mb(s.received)} of ${mb(s.download_bytes)}`),
      s.state === "downloading" ? h("button", { class: "button small", type: "button", onclick: () => void call("etymology.cancel") }, "Cancel") : null);
  }
  return h("div", { class: "etym-setup" }, about,
    s.error ? h("p", { class: "small notice-text" }, s.error) : null,
    h("button", { class: "button primary small", type: "button", onclick: () => void call<EtymStatus>("etymology.download").then((x) => status.set(x), (e) => toast(errorText(e))) },
      icon(Download, 14), s.error ? "Try again" : `Download word origins (${mb(s.download_bytes)})`),
    h("p", { class: "muted small" }, `Downloaded once from Librarium’s releases on GitHub; ${mb(s.disk_bytes)} on this Mac. Nothing is sent when you look a word up.`));
}

/** A word that opens when clicked. */
const termLink = (t: EtymTerm, label = t.term) =>
  h("a", { href: "#", class: "etym-term", title: [t.lang_name, t.gloss].filter(Boolean).join(": "), onclick: (e: MouseEvent) => (e.preventDefault(), show(t.lang === "en" ? { word: t.term } : { key: t.key })) }, label);

// Italics are written with `_`, so a reconstruction's `*` needs no escaping (and shows as written).
const escapeMd = (s: string) => s.replace(/[\\_`[\]]/g, (c) => `\\${c}`);

/** A word's line of descent as a Markdown quotation, with where it is from. */
function lineageMarkdown(e: EtymEntry): string {
  const [first, ...rest] = e.lineage;
  const line = [`**${escapeMd(first?.term.term ?? e.term.term)}**`, ...rest.map((s) => `${s.term.lang_name} _${escapeMd(s.term.term)}_`)].join(" ← ");
  const gloss = e.senses[0]?.gloss ?? e.term.gloss;
  return `> ${line}${gloss ? `\n>\n> ${escapeMd(gloss)}` : ""}\n>\n> — Word origins from Wiktionary (CC BY-SA 4.0) and other dictionaries`;
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

function entryView(e: EtymEntry, noteId: string | null): HTMLElement {
  const steps = e.lineage.slice(1);
  const section = (title: string, ...body: (Node | null)[]) => h("section", { class: "etym-section" }, h("h3", null, title), ...body);
  const chips = (ts: EtymTerm[]) => h("div", { class: "etym-chips" }, ts.map((t) => termLink(t)));
  return h("article", { class: "etym-entry" },
    h("div", { class: "etym-head" },
      h("h2", null, e.term.term), h("span", { class: "muted small" }, [e.term.lang !== "en" ? e.term.lang_name : null, e.pos].filter(Boolean).join(" · ")),
      noteId && steps.length ? iconButton(TextCursorInput, "Insert into the note", () => insertInto(noteId, lineageMarkdown(e)), undefined, 15) : null),
    e.senses.length ? h("ol", { class: "etym-senses small" }, e.senses.slice(0, 2).map((s) => h("li", null, s.gloss))) : e.term.gloss ? h("p", { class: "small" }, e.term.gloss) : null,
    steps.length
      ? section("Line of descent",
          h("ol", { class: "etym-line" }, steps.map((s) =>
            h("li", null, h("span", { class: "muted small" }, s.term.lang_name), " ", termLink(s.term),
              s.with.length ? h("span", { class: "muted small" }, ` + ${s.with.join(" + ")}`) : null,
              s.term.gloss ? h("span", { class: "muted small" }, ` “${s.term.gloss}”`) : null,
              s.rel ? h("span", { class: "etym-rel small" }, s.rel) : null))))
      : h("p", { class: "muted small" }, e.senses.length || e.term.gloss ? "No origin is recorded for this word." : "No origin is recorded for this word. If it is a form of another word (wrote, mice), try that word."),
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
}

addPanelView({
  id: "etymology",
  title: "Word origins",
  icon: Sprout,
  applies: () => true,
  render(host, route) {
    const noteId = route.page === "note" ? (route.params.id ?? null) : null;
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
      if (s.state !== "ready") return replace(host, h("div", { class: "etym-panel" }, setup(s)));
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
        // The sources, as their licences ask, folded under a line.
        replace(result, ...l.entries.map((e) => entryView(e, noteId && router.current.peek().params.id === noteId ? noteId : null)),
          h("details", { class: "etym-attribution muted" }, h("summary", null, "From Wiktionary (CC BY-SA 4.0) and other dictionaries"), h("p", null, l.attribution)));
      }, (e) => ask === asked && replace(result, h("p", { class: "small" }, errorText(e))));
    });
    return () => {
      clearTimeout(timer);
      stop();
    };
  },
});
