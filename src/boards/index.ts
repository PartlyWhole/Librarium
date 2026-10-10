/**
 * Boards: a note you can draw on, with Excalidraw. Kept beside notes in the Notes folders, each
 * is a drawing and a readable page. This module adds the page and the board's actions; React
 * and Excalidraw load only when a board is first shown.
 */
import { call } from "../backend";
import { defineAction } from "../app/actions";
import { folderOf } from "../app/folders";
import { isOpen } from "../app/library";
import { here, pages } from "../app/pages";
import { getRecord, listRecords, openRecord, putRecord, records } from "../app/records";
import { router } from "../app/router";
import { errorText } from "../ui/dom";
import { effect, untracked } from "../ui/signal";
import { toast } from "../ui/toast";
import type { Draft, Written } from "../types";
import { renderBoard, shownBoard } from "./page";
import "./boards.css";
import { Shapes } from "lucide";

pages.board = { title: "Board", icon: Shapes, render: renderBoard };

/** New board: in the folder given (from a folder's menu), else beside the note or board shown,
 * or in the Notes folder being looked at. */
async function newBoard(where?: { folder: string }): Promise<void> {
  const cur = getRecord(untracked(router.current).params.id);
  const at = here.peek();
  const folder = where ? where.folder : cur && (cur.kind === "note" || cur.kind === "board") ? folderOf(cur) : at?.kind === "note" ? at.folder : "";
  try {
    const w = await call<Written>("boards.create", { title: null, folder: folder || null });
    putRecord(w.info);
    router.go("board", { id: w.info.id, focus: "title" });
  } catch (e) {
    toast(errorText(e));
  }
}

const onBoard = () => !!shownBoard();

defineAction({ id: "boards.new", title: "New board", keys: ["Mod+Alt+N"], reserved: true, when: isOpen, run: newBoard, menu: { name: "file", group: 0.5 }, icon: Shapes });
defineAction({ id: "boards.linkTo", title: "Link to…", keys: ["Mod+Alt+K"], reserved: true, when: onBoard, run: () => shownBoard()?.linkTo(), menu: { name: "edit", group: 3.1, title: "Link to a note or item…" } });
defineAction({ id: "boards.insert", title: "Put on the board…", keys: ["Mod+Alt+I"], reserved: true, when: onBoard, run: () => shownBoard()?.insert(), menu: { name: "edit", group: 3.2, title: "Put a capture, note or item on the board…" } });
for (const [as, title, n] of [["png", "Export board as a picture (PNG)…", 0.3], ["svg", "Export board as a picture (SVG)…", 0.4], ["excalidraw", "Export board as an Excalidraw file…", 0.5]] as const) {
  defineAction({ id: `boards.export.${as}`, title, when: onBoard, run: () => void shownBoard()?.exportAs(as), menu: { name: "file", group: 3 + n } });
}

// Drawings not saved before the app stopped: said once, when the library is open.
let offered = false;
effect(() => {
  if (offered || !isOpen() || !records().size) return;
  offered = true;
  const boards = new Set(untracked(() => listRecords("board")).map((r) => r.id));
  void call<Draft[]>("drafts.list").then((all) => {
    const mine = all.filter((d) => boards.has(d.id));
    if (!mine.length) return;
    toast(mine.length === 1 ? "A drawing you hadn’t saved was recovered." : `Drawings you hadn’t saved were recovered on ${mine.length} boards.`, { action: { label: "Show", run: () => openRecord(mine[0]!.id) } });
  }, () => {});
});
