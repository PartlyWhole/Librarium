/**
 * Undo history (temporary, R-049, decision 0053): a side-panel view of what ⌘Z and Undo act on.
 * The open note's text steps come from the editor's own history (exactly what ⌘Z / ⇧⌘Z would
 * do); app actions (renames, moves, archiving) from this session's log. Nothing is kept after
 * the app quits. Self-contained: removing this folder and its line in `main.ts` removes it.
 */
import { editorChanged, editorOn, textHistory, type TextStep } from "../../editor/editor";
import { h, replace } from "../../kit/dom";
import { effect } from "../../kit/signal";
import type { ShellApi } from "../../shell/api";
import type { UndoEntry } from "../../shell/undo";
import { Undo2 } from "lucide";

const STATE: Record<UndoEntry["state"], string> = {
  latest: "Undo would undo this",
  replaced: "Can’t be undone (only the latest can)",
  undone: "Undone",
  failed: "Couldn’t be undone",
};

/** "“abc”", shortened, with line breaks shown. */
const quoted = (s: string) => {
  const one = s.replace(/\n/g, " ⏎ ");
  return `“${one.length > 60 ? `${one.slice(0, 57)}…` : one}”`;
};

function describe(s: TextStep): string {
  if (s.typed && s.deleted) return `Replaced ${quoted(s.deleted)} with ${quoted(s.typed)}`;
  if (s.typed) return `Typed ${quoted(s.typed)}`;
  if (s.deleted) return `Deleted ${quoted(s.deleted)}`;
  return "A change";
}

export function undoHistory(shell: ShellApi): void {
  shell.sidePanel.add("undo-history", "undo-history", {
    id: "undo-history",
    title: "Undo history",
    icon: Undo2,
    applies: () => true,
    render(host, r) {
      const textPart = h("div", { class: "undo-part" });
      const appPart = h("div", { class: "undo-part" });
      replace(host, h("p", { class: "muted small" }, "What ⌘Z and Undo would act on. Kept for this session only."), textPart, appPart);

      // The note's text: re-read as it changes (at most every 150 ms).
      let timer: ReturnType<typeof setTimeout> | undefined;
      const drawText = () => {
        const view = r.page === "note" ? editorOn(document.querySelector(".workspace") ?? document) : null;
        if (!view) {
          replace(textPart, h("h3", { class: "undo-head" }, "Text"), h("p", { class: "muted small" }, "Open a note to see its text steps. In a note, ⌘Z undoes its text, step by step."));
          return;
        }
        const t = textHistory(view);
        const list = (steps: TextStep[], more: number, cls: string) =>
          h("ol", { class: `undo-list ${cls}` }, steps.map((s, i) => h("li", { class: i === 0 ? "next" : "" }, describe(s))), more ? h("li", { class: "muted" }, `and ${more} earlier`) : null);
        replace(textPart,
          h("h3", { class: "undo-head" }, "This note’s text"),
          h("p", { class: "muted small" }, "⌘Z in the note undoes these, newest first; ⇧⌘Z redoes."),
          t.undo.length ? list(t.undo, t.more.undo, "undo") : h("p", { class: "muted small" }, "Nothing to undo."),
          t.redo.length ? [h("h4", { class: "undo-sub" }, "Redo (⇧⌘Z)"), list(t.redo, t.more.redo, "redo")] : null);
      };
      const stopText = effect(() => {
        editorChanged();
        clearTimeout(timer);
        timer = setTimeout(drawText, 150);
      });

      // App actions this session, newest first.
      const stopApp = effect(() => {
        const log = shell.undo.log();
        const time = (ms: number) => new Date(ms).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
        replace(appPart,
          h("h3", { class: "undo-head" }, "Renames, moves, archiving"),
          h("p", { class: "muted small" }, "Undone from the toast’s Undo or Edit ▸ Undo the last rename or move: only the latest."),
          log.length
            ? h("ol", { class: "undo-list app" }, [...log].reverse().map((e) =>
                h("li", { class: `state-${e.state}` },
                  h("div", null, e.message),
                  h("div", { class: "muted small" }, `${time(e.at)} · ${STATE[e.state]}${e.error ? `: ${e.error}` : ""}`),
                  e.state === "latest" ? h("button", { type: "button", class: "link-button small", onclick: () => void shell.undo.undoLast() }, "Undo") : null)))
            : h("p", { class: "muted small" }, "Nothing yet this session."));
      });
      return () => {
        clearTimeout(timer);
        stopText();
        stopApp();
      };
    },
  }, 20);
}
