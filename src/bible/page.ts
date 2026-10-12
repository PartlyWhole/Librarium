/**
 * The Bible page: a chapter in one version, or several side by side, verse beside verse; with
 * Interlinear, the Hebrew or Greek beneath each verse, word by word. Tagged words (the KJV's,
 * the BSB's) and the original's words open a word study in the side panel. Search looks in the
 * first version shown. The versions shown and Interlinear are remembered, and so is the place.
 */
import { call } from "../backend";
import { datasetSetup, dataStatus } from "../app/dataset";
import type { PageContext, PageHandle } from "../app/pages";
import { showPanelView } from "../app/panel";
import { pref } from "../app/prefs";
import { router } from "../app/router";
import { errorText, h, replace } from "../ui/dom";
import { icon, iconButton } from "../ui/icon";
import { effect, signal } from "../ui/signal";
import type { BibleChapter, BibleInfo, BibleRef, BibleTag, BibleVerse, BibleWord } from "../types";
import { ChevronLeft, ChevronRight, Columns2 } from "lucide";

export const bibleStatus = dataStatus("bible");
export const versionsShown = pref<string[]>("bible.versions", ["kjv"]);
const interlinear = pref("bible.interlinear", false);
const place = pref<{ book: string; chapter: number }>("bible.place", { book: "Gen", chapter: 1 });

/** The versions and books, once the data is here. */
let info: Promise<BibleInfo> | null = null;
export const bibleInfo = (): Promise<BibleInfo> => (info ??= call<BibleInfo>("bible.info").catch((e) => ((info = null), Promise.reject(e))));

/** A word chosen for study: its Strong's number, and the original word when it was one. */
export const study = signal<{ strongs: string; word?: BibleWord } | null>(null);
function studyWord(strongs: string, word?: BibleWord): void {
  study.set({ strongs: strongs.split(/[ ,]/)[0]!, word });
  showPanelView("bible-word");
}

/** "John 3:16", "Psalms 3 (title)". */
export function refName(i: BibleInfo, book: string, chapter: number, verse?: number): string {
  const name = i.books.find((b) => b.id === book)?.name ?? book;
  return verse === undefined ? `${name} ${chapter}` : verse === 0 ? `${name} ${chapter} (title)` : `${name} ${chapter}:${verse}`;
}

/** Goes to a chapter (and a verse in it). */
export function goToVerse(book: string, chapter: number, verse?: number): void {
  router.go("bible", { book, chapter: String(chapter), ...(verse !== undefined ? { verse: String(verse) } : {}) });
}

/** A version's words: tagged ones open their study; the rest are plain text. */
function tagged(tags: BibleTag[]): Node[] {
  return tags.map((t) =>
    t.strongs
      ? h("span", { class: "bible-w", title: t.strongs, onclick: (e: MouseEvent) => (e.stopPropagation(), studyWord(t.strongs!)) }, t.text)
      : document.createTextNode(t.text));
}

function verseText(v: BibleVerse, version: string): Node[] {
  const tags = v.tags[version];
  return tags?.length ? tagged(tags) : [document.createTextNode(v.texts[version] ?? "")];
}

/** The Hebrew or Greek of a verse, word by word: the word, its transliteration and its gloss. */
function wordsOf(v: BibleVerse): HTMLElement | null {
  if (!v.words.length) return null;
  const rtl = v.words[0]!.lang !== "G";
  return h("div", { class: `bible-words${rtl ? " rtl" : ""}`, dir: rtl ? "rtl" : "ltr" },
    v.words.map((w) =>
      h("button", { type: "button", class: "bible-word", title: [w.strongs, w.grammar].filter(Boolean).join(" · "), onclick: () => w.strongs && studyWord(w.strongs, w) },
        h("span", { class: "bible-orig", lang: w.lang === "G" ? "grc" : "hbo" }, w.text),
        h("span", { class: "bible-translit", dir: "ltr" }, w.translit ?? ""),
        h("span", { class: "bible-gloss", dir: "ltr" }, (w.gloss ?? "").replace(/[<>]/g, "")))));
}

function chapterView(i: BibleInfo, c: BibleChapter, versions: string[], original: boolean): HTMLElement {
  const name = (id: string) => i.versions.find((v) => v.id === id)?.name ?? id;
  const num = (v: BibleVerse) => h("sup", { class: "bible-num" }, v.verse === 0 ? "" : String(v.verse));
  const body =
    versions.length === 1 && !original
      ? // One version: the chapter as it reads, verse after verse.
        h("div", { class: "bible-flow" }, c.verses.map((v) =>
          v.verse === 0
            ? h("p", { class: "bible-title", dataset: { verse: "0" } }, verseText(v, versions[0]!))
            : h("span", { class: "bible-v", dataset: { verse: String(v.verse) } }, num(v), verseText(v, versions[0]!), " ")))
      : // Several (or with the original): verse beside verse.
        h("div", { class: "bible-rows", style: `--bible-columns: ${versions.length}` },
          versions.length > 1 ? h("div", { class: "bible-row bible-heads" }, h("span"), versions.map((v) => h("div", { class: "bible-head" }, name(v)))) : null,
          c.verses.map((v) =>
            h("div", { class: `bible-row${v.verse === 0 ? " bible-title" : ""}`, dataset: { verse: String(v.verse) } },
              h("span", { class: "bible-num" }, v.verse === 0 ? "" : String(v.verse)),
              versions.map((ver) => h("div", { class: "bible-cell" }, v.texts[ver] === undefined && !v.tags[ver] ? h("span", { class: "muted" }, "—") : verseText(v, ver))),
              original ? wordsOf(v) : null)));
  const credits = [...versions.map((v) => i.versions.find((x) => x.id === v)?.attribution).filter(Boolean), original ? i.attribution.split(". Changed:")[0] + "." : null];
  return h("div", { class: "bible-chapter" },
    h("h1", { class: "bible-heading" }, refName(i, c.book, c.chapter)),
    body,
    h("details", { class: "bible-credits muted" }, h("summary", null, "Sources"), credits.map((t) => h("p", null, t))));
}

export function renderBible(host: HTMLElement, params: Record<string, string>, ctx: PageContext): PageHandle {
  host.classList.add("bible-page");
  ctx.setTitle("Bible");
  const at = signal({ book: params.book || place.peek().book, chapter: Number(params.chapter) || place.peek().chapter, verse: params.verse });
  const results = signal<{ query: string; refs: BibleRef[] } | null>(null);
  const stop = effect(() => {
    const s = bibleStatus();
    if (!s) return replace(host);
    if (s.state !== "ready") {
      return replace(host, h("div", { class: "bible-setup" }, h("h1", { class: "page-title" }, "Bible"),
        datasetSetup("bible", s, { name: "the Bible", about: "Eight English versions (KJV, BSB, YLT, LSV, ASV, RV, Darby, WEB) verse by verse, and the Hebrew and Greek word by word with brief lexicons, from STEP Bible (Tyndale House, Cambridge), eBible.org and the Berean Bible, kept on this Mac." })));
    }
    const where = at();
    const versions = versionsShown();
    const original = interlinear();
    const found = results();
    place.set({ book: where.book, chapter: where.chapter });
    void bibleInfo().then(async (i) => {
      const book = i.books.find((b) => b.id === where.book) ?? i.books[0]!;
      const chapter = Math.min(Math.max(1, where.chapter), book.chapters);
      ctx.setTitle(refName(i, book.id, chapter));
      const content = h("div", { class: "bible-content" }, h("p", { class: "muted small" }, "Opening…"));
      replace(host, toolbar(i, book.id, chapter, versions, original), content);
      if (found) return replace(content, searchView(i, found));
      const c = await call<BibleChapter>("bible.chapter", { book: book.id, chapter, versions, original });
      replace(content, chapterView(i, c, versions, original));
      if (where.verse !== undefined) {
        const el = content.querySelector<HTMLElement>(`[data-verse="${where.verse}"]`);
        el?.scrollIntoView({ block: "center" });
        el?.classList.add("bible-flash");
      }
    }).catch((e) => replace(host, h("p", { class: "empty" }, errorText(e))));
  });

  function toolbar(i: BibleInfo, book: string, chapter: number, versions: string[], original: boolean): HTMLElement {
    const go = (b: string, c: number) => goToVerse(b, c);
    const books = h("select", { class: "bible-select", "aria-label": "Book", onchange: (e: Event) => go((e.target as HTMLSelectElement).value, 1) },
      ["OT", "NT"].map((t) => h("optgroup", { label: t === "OT" ? "Old Testament" : "New Testament" },
        i.books.filter((b) => b.testament === t).map((b) => h("option", { value: b.id, selected: b.id === book }, b.name)))));
    const count = i.books.find((b) => b.id === book)?.chapters ?? 1;
    const chapters = h("select", { class: "bible-select", "aria-label": "Chapter", onchange: (e: Event) => go(book, Number((e.target as HTMLSelectElement).value)) },
      Array.from({ length: count }, (_, n) => h("option", { value: String(n + 1), selected: n + 1 === chapter }, String(n + 1))));
    const bi = i.books.findIndex((b) => b.id === book);
    const prev = chapter > 1 ? [book, chapter - 1] as const : bi > 0 ? [i.books[bi - 1]!.id, i.books[bi - 1]!.chapters] as const : null;
    const next = chapter < count ? [book, chapter + 1] as const : bi < i.books.length - 1 ? [i.books[bi + 1]!.id, 1] as const : null;
    const toggle = (id: string) => {
      const on = versions.includes(id);
      const order = i.versions.map((v) => v.id);
      const nextVersions = on ? versions.filter((v) => v !== id) : [...versions, id].sort((a, b) => order.indexOf(a) - order.indexOf(b));
      if (nextVersions.length) versionsShown.set(nextVersions);
    };
    const search = h("input", { class: "search-input bible-search", type: "search", placeholder: `Search the ${versions[0]!.toUpperCase()} (“in quotes” for a phrase)`, "aria-label": "Search", value: results.peek()?.query ?? "" });
    search.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      const q = search.value.trim();
      if (!q) return results.set(null);
      void call<BibleRef[]>("bible.search", { version: versions[0], query: q }).then((refs) => results.set({ query: q, refs }));
    });
    search.addEventListener("search", () => !search.value && results.set(null));
    return h("div", { class: "bible-toolbar" },
      h("div", { class: "bible-nav" },
        iconButton(ChevronLeft, "Previous chapter", () => prev && go(...prev), undefined, 16),
        books, chapters,
        iconButton(ChevronRight, "Next chapter", () => next && go(...next), undefined, 16)),
      h("div", { class: "bible-versions", role: "group", "aria-label": "Versions" },
        i.versions.map((v) => h("button", { type: "button", class: "bible-version", "aria-pressed": String(versions.includes(v.id)), title: `${v.name}${v.year ? ` (${v.year})` : ""}`, onclick: () => toggle(v.id) }, v.id.toUpperCase())),
        h("button", { type: "button", class: "bible-version bible-interlinear", "aria-pressed": String(original), title: "The Hebrew or Greek beneath each verse, word by word", onclick: () => interlinear.set(!original) }, icon(Columns2, 14), "Interlinear")),
      search);
  }

  function searchView(i: BibleInfo, r: { query: string; refs: BibleRef[] }): HTMLElement {
    return h("div", { class: "bible-results" },
      h("p", { class: "muted small" }, r.refs.length ? `${r.refs.length === 200 ? "The first 200" : r.refs.length} verses with “${r.query}”` : `No verses have “${r.query}”.`),
      r.refs.map((x) => h("a", { href: "#", class: "bible-result", onclick: (e: MouseEvent) => (e.preventDefault(), results.set(null), goToVerse(x.book, x.chapter, x.verse)) },
        h("span", { class: "bible-result-ref" }, refName(i, x.book, x.chapter, x.verse)), h("span", null, x.text))));
  }

  return {
    dispose: () => {
      stop();
      host.classList.remove("bible-page");
    },
    update(next) {
      results.set(null);
      at.set({ book: next.book || at.peek().book, chapter: Number(next.chapter) || at.peek().chapter, verse: next.verse });
      return true;
    },
  };
}
