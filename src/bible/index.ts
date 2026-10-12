/**
 * The Bible: its page (on the ribbon), and the side panel's Word study, which shows a Strong's
 * number's lexicon entries, a word's grammar, and the verses its words are in.
 */
import { call } from "../backend";
import { pages } from "../app/pages";
import { addPanelView } from "../app/panel";
import { h, replace } from "../ui/dom";
import { effect } from "../ui/signal";
import type { BibleGrammar, BibleWordStudy } from "../types";
import { bibleInfo, goToVerse, refName, renderBible, study } from "./page";
import "./bible.css";
import { BookOpenText } from "lucide";

pages.bible = { title: "Bible", icon: BookOpenText, render: renderBible };

/** A lexicon's HTML (Abbott-Smith's entries), as text with its emphasis and line breaks only. */
function lexiconHtml(html: string): DocumentFragment {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const out = document.createDocumentFragment();
  const walk = (from: Node, to: Node) => {
    for (const n of from.childNodes) {
      // STEPBible marks indents with underscores (“__I.”).
      if (n.nodeType === Node.TEXT_NODE) to.appendChild(document.createTextNode((n.textContent ?? "").replace(/_{2,}/g, "")));
      else if (n instanceof Element) {
        const tag = n.tagName.toLowerCase();
        if (tag === "br") to.appendChild(document.createElement("br"));
        else if (tag === "b" || tag === "i" || tag === "em" || tag === "strong") walk(n, to.appendChild(document.createElement(tag)));
        else walk(n, to);
      }
    }
  };
  walk(doc.body, out);
  return out;
}

const unquote = (s: string | null) => (s ?? "").replace(/^"|"$/g, "");

addPanelView({
  id: "bible-word",
  title: "Word study",
  icon: BookOpenText,
  applies: (r) => r.page === "bible",
  render(host) {
    let asked = 0;
    return effect(() => {
      const s = study();
      if (!s) return replace(host, h("div", { class: "bible-study" }, h("p", { class: "muted small" }, "Click a word in the Hebrew or Greek (Interlinear), or a tagged word in the KJV or BSB, to see what it means and where else it is.")));
      const ask = ++asked;
      replace(host, h("div", { class: "bible-study" }, h("p", { class: "muted small" }, "Looking it up…")));
      void Promise.all([
        call<BibleWordStudy>("bible.word", { strongs: s.strongs }),
        s.word?.grammar ? call<BibleGrammar[]>("bible.grammar", { code: s.word.grammar }) : Promise.resolve([]),
        bibleInfo(),
      ]).then(([w, grammar, i]) => {
        if (ask !== asked) return;
        const main = w.entries[0];
        replace(host, h("div", { class: "bible-study" },
          s.word ? h("div", { class: "bible-study-word" }, h("span", { class: "bible-orig" }, s.word.text), s.word.translit ? h("span", { class: "muted" }, ` ${s.word.translit}`) : null, s.word.gloss ? h("span", null, ` “${s.word.gloss.replace(/[<>]/g, "")}”`) : null) : null,
          grammar.length ? h("ul", { class: "bible-grammar small" }, grammar.map((g) => h("li", null, h("strong", null, unquote(g.brief) || g.code), g.description ? ` — ${g.description}` : ""))) : null,
          w.entries.length
            ? w.entries.map((e) => h("section", { class: `bible-entry${e === main ? "" : " sense"}` },
                h("div", { class: "bible-entry-head" }, h("span", { class: "bible-lemma" }, e.lemma ?? ""), h("span", { class: "muted small" }, [e.translit, e.strongs, e.grammar].filter(Boolean).join(" · "))),
                h("p", { class: "small" }, [e.relation, e.gloss].filter(Boolean).join(" ")),
                e.definition ? h("div", { class: "bible-definition small" }, lexiconHtml(e.definition)) : null))
            : h("p", { class: "muted small" }, `${w.strongs} isn’t in the lexicons.`),
          h("h3", { class: "bible-study-h" }, `${w.count.toLocaleString()} ${w.count === 1 ? "word" : "words"} in the Hebrew and Greek`),
          h("ol", { class: "bible-occurrences small" }, w.verses.map((v) =>
            h("li", null, h("a", { href: "#", onclick: (e: MouseEvent) => (e.preventDefault(), goToVerse(v.book, v.chapter, v.verse)) }, refName(i, v.book, v.chapter, v.verse)), " ", h("span", { class: "muted" }, v.text)))),
          w.verses.length < w.count && w.verses.length === 300 ? h("p", { class: "muted small" }, "The first 300 verses.") : null));
      }, () => ask === asked && replace(host, h("div", { class: "bible-study" }, h("p", { class: "muted small" }, "That word can’t be looked up."))));
    });
  },
});
