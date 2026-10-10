/**
 * Notes: the note page and its actions (New note, the Format menu, Show history, Export with
 * quotations), the History, Links and Outline views of the side panel, and the text recovered
 * from an earlier run.
 */
import { call, pickSavePath } from "../backend";
import { defineAction } from "../app/actions";
import { folderOf } from "../app/folders/model";
import { isOpen } from "../app/library";
import { here, pages } from "../app/pages";
import { showPanelView } from "../app/panel";
import { getRecord, openRecord, putRecord, records } from "../app/records";
import { router } from "../app/router";
import { showStatus } from "../app/status";
import { editorChanged } from "../app/undo";
import { errorText } from "../ui/dom";
import { effect, untracked } from "../ui/signal";
import { toast } from "../ui/toast";
import type { Draft, RecordText, Written } from "../types";
import { activeEditor } from "./editor/editor";
import { FORMATS } from "./editor/format";
import { parseLinks } from "./editor/links";
import { embedMarkdown } from "./embeds";
import { flushNote, renderNote } from "./page";
import "./history";
import "./panels";
import "./notes.css";
import { FilePlus, FileText } from "lucide";

pages.note = { title: "Note", icon: FileText, render: renderNote };

const shownNote = () => (router.current().page === "note" ? router.current().params.id : undefined);

/** New note: in the folder given (from a folder's menu), else beside the note shown, or in the
 * Notes folder being looked at; its title focused. */
async function newNote(where?: { folder: string }): Promise<void> {
  const cur = getRecord(untracked(shownNote));
  const at = here.peek();
  const folder = where ? where.folder : cur ? folderOf(cur) : at?.kind === "note" ? at.folder : "";
  try {
    const w = await call<Written>("notes.create", { folder: folder || null });
    putRecord(w.info);
    router.go("note", { id: w.info.id, focus: "title" });
  } catch (e) {
    toast(errorText(e));
  }
}

/** A note's text with each embed written out, for reading outside the app. */
function expandEmbeds(body: string): string {
  let out = "";
  let last = 0;
  for (const l of parseLinks(body)) {
    if (!l.embed) continue;
    const r = l.id ? getRecord(l.id) : undefined;
    out += body.slice(last, l.from) + (r ? embedMarkdown(r) : l.label);
    // A picture's width goes with it.
    last = /^\{width=\d{1,5}\}/.exec(body.slice(l.to, l.to + 16)) ? body.indexOf("}", l.to) + 1 : l.to;
  }
  return out + body.slice(last);
}

async function exportWithQuotations(): Promise<void> {
  const id = untracked(shownNote);
  if (!id) return;
  try {
    await flushNote(id);
    const t = await call<RecordText>("records.read", { id });
    const path = await pickSavePath(`${t.info.title || "note"}.md`, "Export with quotations");
    if (!path) return;
    await call("export.write", { path, text: expandEmbeds(t.body), data: null });
    showStatus("Exported, with each quotation written out.");
  } catch (e) {
    toast(errorText(e));
  }
}

defineAction({ id: "notes.new", title: "New note", keys: ["Mod+N"], reserved: true, when: isOpen, run: newNote, menu: { name: "file", group: 0.3 }, icon: FilePlus });
defineAction({ id: "notes.history", title: "Show history", keys: ["Mod+Alt+Y"], when: () => !!shownNote(), run: () => showPanelView("history"), menu: { name: "file", group: 3.1 } });
defineAction({ id: "notes.export", title: "Export with quotations…", when: () => !!shownNote(), run: exportWithQuotations, menu: { name: "file", group: 3.2 } });

// The Format menu: the formatting keys, for the editor last used.
FORMATS.forEach((f, i) =>
  defineAction({
    id: `format.${f.id}`,
    title: f.title,
    keys: [f.keys],
    when: () => (editorChanged(), router.current(), !!activeEditor()),
    menu: { name: "format", group: i < 5 ? 0 : i < 7 ? 1 : 2 },
    run: () => {
      const v = activeEditor();
      if (!v) return;
      f.run(v);
      v.focus();
    },
  }),
);

// Text recovered from an earlier run is offered once the library is open and its records known.
let offered = false;
effect(() => {
  if (offered || !isOpen() || !records().size) return;
  offered = true;
  void call<Draft[]>("drafts.list").then((all) => {
    // Notes' drafts (boards offer their own).
    const drafts = all.filter((d) => (getRecord(d.id)?.kind ?? "note") === "note");
    if (!drafts.length) return;
    toast(drafts.length === 1 ? "Text you hadn’t saved was recovered." : `Text you hadn’t saved was recovered in ${drafts.length} notes.`, { action: { label: "Show", run: () => openRecord(drafts[0]!.id) } });
  }, () => {});
});
