/** Archive: the first of deletion's two steps. */
import { h, replace } from "../../kit/dom";
import type { ShellApi } from "../../shell/api";
import { Archive } from "lucide";

export function archive(shell: ShellApi): void {
  shell.pages.add("archive", "archive", {
    id: "archive",
    title: "Archive",
    icon: Archive,
    ribbon: 4,
    render(host) {
      replace(host, h("h1", { class: "page-title" }, "Archive"), h("p", { class: "empty" }, "Nothing is archived."));
    },
  });
}
