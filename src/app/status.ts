/** The status bar's words: a passing message on the left, the page's own counts on the right. */
import { signal } from "../ui/signal";

export const message = signal("");
/** What the page shown says about itself (a note's word count). */
export const context = signal("");

let timer: ReturnType<typeof setTimeout> | undefined;

/** A calm message, cleared after `ms` (0: kept). */
export function showStatus(text: string, ms = 4000): void {
  clearTimeout(timer);
  message.set(text);
  if (ms > 0) timer = setTimeout(() => message.set(""), ms);
}
