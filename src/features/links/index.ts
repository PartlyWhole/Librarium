/** Links: everything lists what points to it. The Links view of the side panel: backlinks, and a
 * note's links without a target. */
import { call, on } from "../../backend";
import { h, replace } from "../../kit/dom";
import { comboboxDialog } from "../../kit/combobox";
import { toast } from "../../kit/toast";
import type { ShellApi } from "../../shell/api";
import type { Backlink } from "../../generated/Backlink";
import type { Unresolved } from "../../generated/Unresolved";
import { Link2 } from "lucide";

export function links(shell: ShellApi): void {
  // One view in the side panel: what links here, then (for a note) its links without a target.
  shell.sidePanel.add("links", "links", {
    id: "links",
    title: "Links",
    icon: Link2,
    applies: (r) => !!r.params.id && (r.page === "note" || r.page === "item" || r.page === "capture" || r.page === "board"),
    render(host, r) {
      const id = r.params.id!;
      const note = r.page === "note";
      let alive = true;
      const choose = (u: Unresolved) =>
        comboboxDialog({
          label: `Link “${u.label}” to`,
          placeholder: "Type a title",
          emptyText: "Nothing has that title.",
          choices: shell.records.list().filter((x) => shell.openers.get(x.kind)).map((x) => ({ id: x.id, label: x.title || "Untitled", detail: x.kind === "note" ? undefined : x.kind })),
          onPick: (c) => void call("links.resolve", { source: u.source, label: u.label, target: c.id }).then(() => toast(`Linked to “${c.label}”.`), (e) => toast(String(e?.message ?? e))),
        });
      const load = async () => {
        let back: Backlink[];
        try {
          back = await call<Backlink[]>("links.backlinks", { id });
        } catch (e) {
          if (alive) replace(host, h("p", { class: "muted" }, String((e as { message?: string }).message ?? e)));
          return;
        }
        const loose = note ? await call<Unresolved[]>("links.unresolved", { id }).catch(() => [] as Unresolved[]) : [];
        if (!alive) return;
        replace(host,
          h("h3", { class: "panel-subtitle" }, "Linked from"),
          back.length === 0 ? h("p", { class: "muted small" }, "Nothing links here yet.") : h("ul", { class: "backlinks" }, back.map((b) => h("li", null, h("a", { href: "#", class: "list-link", onclick: (e: Event) => (e.preventDefault(), shell.openRecord(b.source)) }, b.title || "Untitled"), b.context ? h("div", { class: "muted small" }, b.context) : null))),
          loose.length ? [h("h3", { class: "panel-subtitle" }, "Links without a target"), h("ul", { class: "backlinks" }, loose.map((u) => h("li", null, h("span", null, `“${u.label}” `), h("button", { class: "link-button", onclick: () => choose(u) }, "Choose its target…"))))] : null,
        );
      };
      void load();
      const off = on("event.indexed", () => void load());
      return () => {
        alive = false;
        off();
      };
    },
  });
}
