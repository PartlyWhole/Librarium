/** Search: one search over everything, ranked, with marked passages that open at their place. */
import { call } from "../backend";
import { pages } from "../app/pages";
import { openRecord } from "../app/records";
import { router } from "../app/router";
import { errorText, h, replace } from "../ui/dom";
import type { SearchHit } from "../types";
import { Search } from "lucide";
import "./search.css";

const KINDS: [string, string][] = [
  ["", "Everything"],
  ["note", "Notes"],
  ["item", "Library"],
  ["capture", "Captures"],
];

/** The snippet with its matches marked (between U+0002 and U+0003, from the index). */
function snippet(text: string): Node[] {
  return text.split("\u0002").flatMap((part, i) => {
    if (i === 0) return part ? [document.createTextNode(part)] : [];
    const [marked = "", rest = ""] = part.split("\u0003");
    return [h("mark", null, marked), ...(rest ? [document.createTextNode(rest)] : [])];
  });
}

pages.search = {
  title: "Search",
  icon: Search,
  render(host, params) {
    const kind = params.kind ?? "";
    const input = h("input", { class: "search-input", type: "search", placeholder: "Search everything", "aria-label": "Search everything", value: params.q ?? "", spellcheck: false });
    const chips = h("div", { class: "chips", role: "radiogroup", "aria-label": "Search in" },
      KINDS.map(([k, label]) => h("button", { class: `chip${k === kind ? " on" : ""}`, role: "radio", "aria-checked": String(k === kind), onclick: () => router.go("search", { ...params, kind: k }, { replace: true }) }, label)));
    const results = h("div", { class: "results", "aria-live": "polite" });
    replace(host, input, chips, results, h("p", { class: "muted small" }, "Words match by their beginning. Use \"quotes\" for a phrase and -word to leave a word out."));
    let alive = true;
    const run = async () => {
      const q = input.value.trim();
      if (!q) return;
      try {
        const hits = await call<SearchHit[]>("search.query", { text: q, kinds: kind ? [kind] : [], limit: 50 });
        if (!alive) return;
        replace(results, hits.length === 0
          ? h("p", { class: "empty" }, "Nothing matches.")
          : h("ol", { class: "hit-list" }, hits.map((hit) => h("li", null,
              h("a", { href: "#", class: "hit", onclick: (e: Event) => (e.preventDefault(), openRecord(hit.id, { at: String(hit.offset) })) },
                h("span", { class: "hit-title" }, hit.title || "Untitled", h("span", { class: "hit-kind" }, hit.kind === "note" ? "" : hit.kind)),
                h("span", { class: "hit-snippet" }, snippet(hit.snippet)))))));
      } catch (e) {
        if (alive) replace(results, h("p", { class: "empty" }, errorText(e)));
      }
    };
    // The query is kept in the route, so Back and the saved tabs bring it back.
    let timer: ReturnType<typeof setTimeout> | undefined;
    input.addEventListener("input", () => {
      clearTimeout(timer);
      timer = setTimeout(() => router.go("search", { ...params, q: input.value }, { replace: true }), 150);
    });
    // ↓ moves from the field into the results, and between them.
    input.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowDown" || e.isComposing) return;
      e.preventDefault();
      results.querySelector<HTMLElement>("a.hit")?.focus();
    });
    results.addEventListener("keydown", (e) => {
      const links = [...results.querySelectorAll<HTMLElement>("a.hit")];
      const i = links.indexOf(document.activeElement as HTMLElement);
      if (e.key === "ArrowDown") links[i + 1]?.focus();
      else if (e.key === "ArrowUp") (i > 0 ? links[i - 1] : input)?.focus();
      else return;
      e.preventDefault();
    });
    void run();
    requestAnimationFrame(() => {
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    });
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  },
};
