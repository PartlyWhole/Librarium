/**
 * Pictures, PDFs and EPUBs put into a note, by pasting or dropping. They become library items
 * (pictures in Library ▸ Attachments, documents at the Library's top level) and are embedded
 * on their own lines where they came in. Anything else is refused.
 */
import { EditorView } from "@codemirror/view";
import { call, onFileDrop } from "../backend";
import { putRecord } from "../app/records";
import { showStatus } from "../app/status";
import { errorText } from "../ui/dom";
import { count } from "../ui/format";
import { toast } from "../ui/toast";
import type { ImportResult, Written } from "../types";
import { ATTACHMENTS, base64, DOCUMENT_EXTENSIONS, extension, isImagePath, MAX_PASTE, pastedName } from "../library/files";
import { insertEmbeds } from "./editor/editor";

/** The editor at a point in the window, if a note's editor is shown there. */
export function editorAt(at: { x: number; y: number }): EditorView | null {
  const el = document.elementFromPoint(at.x, at.y)?.closest<HTMLElement>(".cm-editor");
  return el && !el.closest("[hidden]") ? EditorView.findFromDOM(el) : null;
}

/** Shows what came in, and says where it was kept. */
function embed(view: EditorView, written: Written[], at?: { x: number; y: number }): void {
  if (!written.length) return;
  for (const w of written) putRecord(w.info);
  insertEmbeds(view, written.map((w) => ({ label: w.info.title || "Image", id: w.info.id })), at);
  const pictures = written.every((w) => w.info.fields["library.format"] === "image");
  const one = written.length === 1 ? `“${written[0]!.info.title}”` : "";
  showStatus(pictures
    ? `Attached ${one || count(written.length, "picture")} (in the Library’s ${ATTACHMENTS}).`
    : `Added ${one || count(written.length, "item")} to the library.`);
}

/** Files dropped on a note: pictures go to Attachments, documents to the Library's top. */
async function dropped(view: EditorView, paths: string[], at: { x: number; y: number }): Promise<void> {
  const refused = paths.filter((p) => !isImagePath(p) && !DOCUMENT_EXTENSIONS.includes(extension(p)));
  for (const p of refused) toast(`“${p.split("/").pop()}” isn’t a picture, a PDF or an EPUB.`);
  const written: Written[] = [];
  const groups: [string[], string | null][] = [
    [paths.filter(isImagePath), ATTACHMENTS],
    [paths.filter((p) => DOCUMENT_EXTENSIONS.includes(extension(p))), null],
  ];
  try {
    for (const [list, folder] of groups) {
      if (!list.length) continue;
      const r = await call<ImportResult>("library.import", { paths: list, ...(folder ? { folder } : {}) });
      for (const f of r.failed) toast(f.error);
      written.push(...r.imported);
    }
  } catch (e) {
    toast(errorText(e));
  }
  embed(view, written, at);
}

/** Files pasted into a note (a picture copied in another app). */
export async function pasted(view: EditorView, files: File[]): Promise<void> {
  const written: Written[] = [];
  for (const f of files) {
    const picture = f.type.startsWith("image/");
    if (!picture && !/application\/pdf|epub/.test(f.type)) {
      toast(`“${f.name || "That"}” isn’t a picture, a PDF or an EPUB.`);
      continue;
    }
    if (f.size > MAX_PASTE) {
      toast(`“${f.name || "That"}” is too large to paste (over 50 MB); add it as a file.`);
      continue;
    }
    try {
      const data = base64(new Uint8Array(await f.arrayBuffer()));
      written.push(await call<Written>("library.importData", { name: pastedName(f), data, ...(picture ? { folder: ATTACHMENTS } : {}) }));
    } catch (e) {
      toast(errorText(e));
    }
  }
  embed(view, written);
}

// Files dropped on a note's text. (Drops elsewhere are the Library's.)
onFileDrop((paths, at) => {
  const view = editorAt(at);
  if (view && !view.state.readOnly) void dropped(view, paths, at);
});
