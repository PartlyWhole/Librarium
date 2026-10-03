/** `[[` opens link suggestions; picking one inserts `[[label|id]]`. */
import { autocompletion, type Completion, type CompletionContext, type CompletionResult } from "@codemirror/autocomplete";
import { fuzzyFilter } from "../kit/fuzzy";
import { formatLink } from "./links";

export interface LinkTarget {
  id: string;
  title: string;
  detail?: string;
  /** Offered after `![[` (captures). */
  embeddable?: boolean;
}

export function linkCompletion(targets: () => LinkTarget[]) {
  const source = (cx: CompletionContext): CompletionResult | null => {
    const m = cx.matchBefore(/!?\[\[[^\][\n|]*$/);
    if (!m) return null;
    const embed = m.text.startsWith("!");
    const start = m.from + (embed ? 1 : 0);
    const query = m.text.slice(embed ? 3 : 2);
    // An auto-closed "]]" after the cursor is replaced too.
    const after = cx.state.sliceDoc(cx.pos, cx.pos + 2);
    const to = after === "]]" ? cx.pos + 2 : cx.pos;
    const pool = targets().filter((t) => (embed ? t.embeddable : true));
    const options: Completion[] = fuzzyFilter(pool, query, (t) => t.title, 50).map((t) => ({
      label: t.title || "Untitled",
      detail: t.detail,
      apply: (view) => {
        const text = formatLink(t.title || "Untitled", t.id, embed);
        const from = embed ? start - 1 : start;
        view.dispatch({ changes: { from, to, insert: text }, selection: { anchor: from + text.length }, userEvent: "input.complete" });
      },
    }));
    return { from: start + 2, to: cx.pos, options, filter: false };
  };
  return autocompletion({ override: [source], activateOnTyping: true, icons: false });
}
