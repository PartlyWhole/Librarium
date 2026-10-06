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
import { renderBoard } from "./page";
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
