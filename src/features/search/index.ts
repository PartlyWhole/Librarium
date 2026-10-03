/** Search: one search over everything, ranked, with highlighted passages that open at the exact place. */
import { call } from "../../backend";
import { h, replace } from "../../kit/dom";
import type { ShellApi } from "../../shell/api";
import type { SearchHit } from "../../generated/SearchHit";
import { Search } from "lucide";

const KINDS: [string, string][] = [
  ["", "Everything"],
  ["note", "Notes"],
  ["item", "Library"],
  ["capture", "Captures"],
];

/** The snippet with matches marked (U+0002 … U+0003 from the index). */
export function snippet(text: string): Node[] {
  const out: Node[] = [];
  const [open, close] = [String.fromCharCode(2), String.fromCharCode(3)];
  for (const [i, part] of text.split(open).entries()) {
    if (i === 0) {
      if (part) out.push(document.createTextNode(part));
      continue;
    }
    const end = part.indexOf(close);
    const marked = end < 0 ? part : part.slice(0, end);
    const rest = end < 0 ? "" : part.slice(end + 1);
    out.push(h("mark", null, marked));
    if (rest) out.push(document.createTextNode(rest));
  }
  return out;
}

export function search(shell: ShellApi): void {
  shell.pages.add("search", "search", {
    id: "search",
    title: "Search",
    icon: Search,
    ribbon: 3,
    keys: "Mod+Shift+F",
    render(host, params) {
      const input = h("input", { class: "search-input", type: "search", placeholder: "Search everything", "aria-label": "Search everything", value: params.q ?? "", spellcheck: false });
      const kind = params.kind ?? "";
      const filters = h("div", { class: "chips", role: "radiogroup", "aria-label": "Search in" }, KINDS.map(([k, label]) => h("button", { class: `chip ${k === kind ? "on" : ""}`, role: "radio", "aria-checked": String(k === kind), onclick: () => shell.router.go("search", { ...params, kind: k }, { replace: true }) }, label)));
      const results = h("div", { class: "results", "aria-live": "polite" });
      const hint = h("p", { class: "muted small" }, "Words match by their beginning. Use \"quotes\" for a phrase and -word to leave a word out.");
      replace(host, input, filters, results, hint);
      let timer: ReturnType<typeof setTimeout> | undefined;
      let n = 0;
      const run = async () => {
        const q = input.value.trim();
        const mine = ++n;
        if (!q) {
          replace(results);
          return;
        }
        try {
          const hits = await call<SearchHit[]>("search.query", { text: q, kinds: kind ? [kind] : [], limit: 50, hide: shell.hidingFields.values() });
          if (mine !== n) return;
          replace(
            results,
            hits.length === 0
              ? h("p", { class: "empty" }, "Nothing matches.")
              : h("ol", { class: "hit-list" }, hits.map((hit) =>
                  h("li", null, h("a", { href: "#", class: "hit", onclick: (e: Event) => (e.preventDefault(), shell.openRecord(hit.id, { at: String(hit.offset) })) }, h("span", { class: "hit-title" }, hit.title || "Untitled", h("span", { class: "hit-kind" }, hit.kind === "note" ? "" : hit.kind)), h("span", { class: "hit-snippet" }, snippet(hit.snippet)))),
                )),
          );
        } catch (e) {
          if (mine === n) replace(results, h("p", { class: "empty" }, String((e as { message?: string }).message ?? e)));
        }
      };
      input.addEventListener("input", () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          shell.router.go("search", { ...params, q: input.value }, { replace: true });
        }, 150);
      });
      input.addEventListener("keydown", (e) => {
        if (e.key === "ArrowDown" && !e.isComposing) {
          e.preventDefault();
          results.querySelector<HTMLElement>("a.hit")?.focus();
        }
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
      return () => clearTimeout(timer);
    },
  });
}
