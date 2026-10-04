/**
 * The EPUB engine. Readium and the engine built on it (epub/engine.ts, decision 0045) load the
 * first time a book is opened, not with the app.
 */
import type { ReaderEngine } from "./host";

export const epubEngine: ReaderEngine = {
  id: "epub",
  formats: ["epub"],
  async open(host, src, events) {
    const { readiumEngine } = await import("./epub/engine");
    return readiumEngine.open(host, src, events);
  },
};
