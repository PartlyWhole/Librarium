/**
 * The readers open, for features that work in them (captures): each item page's reader is
 * announced to `onReaderOpen` listeners as it opens, and `currentReader` is the one shown.
 */
import { router } from "../app/router";
import { computed, signal, type ReadSignal } from "../ui/signal";
import type { RecordInfo, StoredText } from "../types";
import type { ReaderView } from "./types";

export interface OpenReader {
  source: RecordInfo;
  /** The snapshot shown (saved web pages). */
  snapshot?: string;
  view: ReaderView;
  /** The stored text anchors point into (`records.text`: joined text and labelled segments), fetched once. */
  text(): Promise<StoredText | null>;
  /** Where tools put their buttons in the toolbar. */
  tools: HTMLElement;
  /** The positioned area holding the document, for bars over it. */
  body: HTMLElement;
}

type Listener = (r: OpenReader) => (() => void) | void;
const listeners: Listener[] = [];
const open = signal<ReadonlyMap<string, OpenReader>>(new Map());

/** Calls `fn` for every reader as it opens; what `fn` returns runs when that reader closes. */
export function onReaderOpen(fn: Listener): void {
  listeners.push(fn);
}

/** The reader on the item page shown, or null (reading it inside an effect subscribes). */
export const currentReader: ReadSignal<OpenReader | null> = computed(() => {
  const r = router.current();
  return r.page === "item" ? (open().get(r.params.id ?? "") ?? null) : null;
});

/** Announces an opened reader; returns what closes it. */
export function announce(r: OpenReader): () => void {
  open.set(new Map(open.peek()).set(r.source.id, r));
  const done = listeners.map((fn) => {
    try {
      return fn(r);
    } catch (e) {
      console.error("a reader tool failed", e);
    }
  });
  return () => {
    done.forEach((d) => d?.());
    if (open.peek().get(r.source.id) !== r) return;
    const m = new Map(open.peek());
    m.delete(r.source.id);
    open.set(m);
  };
}
