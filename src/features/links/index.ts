/** Links: everything lists what points to it. Backlinks and unresolved links in the side panel. */
import { call, on } from "../../backend";
import { h, replace } from "../../kit/dom";
import { comboboxDialog } from "../../kit/combobox";
import { toast } from "../../kit/toast";
import type { ShellApi } from "../../shell/api";
import type { Backlink } from "../../generated/Backlink";
import type { Unresolved } from "../../generated/Unresolved";

export function links(shell: ShellApi): void {
  shell.sidePanel.add("links", "backlinks", {
    id: "backlinks",
    title: "Linked from",
    applies: (r) => !!r.params.id && (r.page === "note" || r.page === "item"),
    render(host, r) {
      const id = r.params.id!;
      let alive = true;
      const load = async () => {
        try {
          const list = await call<Backlink[]>("links.backlinks", { id });
          if (!alive) return;
          replace(host, list.length === 0 ? h("p", { class: "muted" }, "Nothing links here yet.") : h("ul", { class: "backlinks" }, list.map((b) => h("li", null, h("a", { href: "#", class: "list-link", onclick: (e: Event) => (e.preventDefault(), shell.openRecord(b.source)) }, b.title || "Untitled"), b.context ? h("div", { class: "muted small" }, b.context) : null))));
        } catch (e) {
          if (alive) replace(host, h("p", { class: "muted" }, String((e as { message?: string }).message ?? e)));
        }
      };
      void load();
      const off = on("event.indexed", () => void load());
      return () => {
        alive = false;
        off();
      };
    },
  });

  shell.sidePanel.add("links", "unresolved", {
    id: "unresolved",
    title: "Links without a target",
    applies: (r) => r.page === "note" && !!r.params.id,
    render(host, r) {
      const id = r.params.id!;
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
        const list = await call<Unresolved[]>("links.unresolved", { id }).catch(() => [] as Unresolved[]);
        if (!alive) return;
        replace(host, list.length === 0 ? h("p", { class: "muted" }, "Every link here points to a record.") : h("ul", { class: "backlinks" }, list.map((u) => h("li", null, h("span", null, `“${u.label}” `), h("button", { class: "link-button", onclick: () => choose(u) }, "Choose its target…")))));
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
