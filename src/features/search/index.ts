/** Search: one search over everything. */
import { h, replace } from "../../kit/dom";
import type { ShellApi } from "../../shell/api";
import { Search } from "lucide";

export function search(shell: ShellApi): void {
  shell.pages.add("search", "search", {
    id: "search",
    title: "Search",
    icon: Search,
    ribbon: 3,
    keys: "Mod+Shift+F",
    render(host) {
      const input = h("input", { class: "search-input", type: "search", placeholder: "Search everything", "aria-label": "Search everything" });
      replace(host, h("h1", { class: "page-title" }, "Search"), input, h("p", { class: "empty" }, "Search results appear here."));
      input.focus();
    },
  });
}
