/**
 * Boards: a note you can draw on, with Excalidraw (docs/plans/boards.md; decisions 0061, 0062).
 * Boards are kept beside notes, in the Notes folders; each is a readable page and a drawing.
 */
import { call } from "../../backend";
import { effect, untracked } from "../../kit/signal";
import { toast } from "../../kit/toast";
import { folderOf } from "../../shell/folders/model";
import type { ShellApi } from "../../shell/api";
import type { Draft } from "../../generated/Draft";
import type { Written } from "../../generated/Written";
import { appTheme, boardSvg, renderBoard, shownBoards } from "./page";
import { h, replace } from "../../kit/dom";
import { Shapes } from "lucide";

const KIND = "board";

export function boards(shell: ShellApi): void {
  shell.openers.add("boards", KIND, "board");
  shell.looks.add("boards", KIND, { kind: KIND, icon: () => Shapes, kindName: () => "Board" });
  shell.pages.add("boards", "board", {
    id: "board",
    title: "Board",
    icon: Shapes,
    render: (host, params, ctx) => renderBoard(shell, host, params, ctx),
  });

  shell.actions.add("boards", {
    id: "boards.new",
    title: "New board",
    keys: ["Mod+Alt+N"],
    reserved: true,
    when: () => shell.folder()?.state === "open",
    menu: { name: "file", group: 0 },
    icon: Shapes,
    run: async () => {
      const r = shell.router.current.peek();
      const cur = r.params.id ? shell.records.get(r.params.id) : undefined;
      // Beside the note or board being looked at, or in the Notes folder being looked at.
      const here = shell.here.peek();
      const folder = cur && (cur.kind === "note" || cur.kind === KIND) ? folderOf(cur) || undefined : here?.kind === "note" ? here.folder || undefined : undefined;
      try {
        const w = await call<Written>("boards.create", { folder });
        shell.records.put(w.info, w.seq);
        shell.router.go("board", { id: w.info.id, focus: "title" });
      } catch (e) {
        toast(String((e as { message?: string }).message ?? e));
      }
    },
  });

  // Links from a board: what is selected, to a record (⌘K stays Excalidraw's link to the web).
  const shownBoard = () => {
    const r = shell.router.current();
    return r.page === "board" ? shownBoards.get(r.params.id ?? "") : undefined;
  };
  shell.actions.add("boards", {
    id: "boards.linkTo",
    title: "Link to…",
    keys: ["Mod+Alt+K"],
    reserved: true,
    when: () => !!shownBoard(),
    menu: { name: "edit", group: 3, title: "Link to a note or item…" },
    run: () => shownBoard()?.linkTo(),
  });

  // Captures, notes, items and pictures, put on the board shown.
  shell.actions.add("boards", {
    id: "boards.insert",
    title: "Put on the board…",
    keys: ["Mod+Alt+I"],
    reserved: true,
    when: () => !!shownBoard(),
    menu: { name: "edit", group: 3, title: "Put a capture, note or item on the board…" },
    run: () => shownBoard()?.insert(),
  });

  // The board elsewhere (0066): to a file, and shown as a picture in notes (`![[Board|id]]`).
  for (const [as, title] of [["png", "Export board as a picture (PNG)…"], ["svg", "Export board as a picture (SVG)…"], ["excalidraw", "Export board as an Excalidraw file…"]] as const) {
    shell.actions.add("boards", {
      id: `boards.export.${as}`,
      title,
      when: () => !!shownBoard(),
      menu: { name: "file", group: 3 },
      run: () => void shownBoard()?.exportAs(as),
    });
  }
  shell.embeds.add("boards", KIND, {
    kind: KIND,
    render(r, open) {
      const picture = h("div", { class: "embed-board-picture", role: "img", "aria-label": `The board “${r.title || "Untitled board"}”` }, h("span", { class: "muted small" }, "Drawing the board…"));
      const go = (e: Event) => (e.preventDefault(), open(r.id));
      void boardSvg(shell, r.id, appTheme() === "dark").then(
        (svg) => {
          svg.removeAttribute("width");
          svg.removeAttribute("height");
          replace(picture, svg);
        },
        () => replace(picture, h("span", { class: "muted small" }, "This board can’t be drawn here.")),
      );
      return h("figure", { class: "embed embed-board" }, h("a", { href: "#", class: "embed-board-link", onclick: go, title: "Open the board" }, picture), h("figcaption", null, h("a", { href: "#", class: "embed-cite", onclick: go }, `— ${r.title || "Untitled board"}`)));
    },
    // Export with quotations: a link to the board's readable page.
    markdown: (r) => `[${r.title || "Board"}](${r.path})`,
  });

  // Drawings not saved before the app stopped: said once, when the library opens.
  let offered = false;
  const offer = () => {
    if (offered || shell.folder.peek()?.state !== "open" || !shell.records.list(KIND).length) return;
    offered = true;
    void call<Draft[]>("drafts.list").then((drafts) => {
      const mine = drafts.filter((d) => shell.records.get(d.id)?.kind === KIND);
      if (!mine.length) return;
      toast(mine.length === 1 ? "A drawing you hadn’t saved was recovered." : `Drawings you hadn’t saved were recovered on ${mine.length} boards.`, { action: { label: "Show", run: () => shell.openRecord(mine[0]!.id) } });
    }, () => {});
  };
  effect(() => (shell.records.byId(), shell.folder(), untracked(offer)));
}
