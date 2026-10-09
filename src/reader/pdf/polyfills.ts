/**
 * Polyfills for macOS 15's WebKit (Safari 18), loaded before PDF.js: it reads text with
 * `for await (… of readableStream)`, which this WebKit lacks.
 */
type AsyncIterableStream = ReadableStream & { [Symbol.asyncIterator]?: unknown };

const proto = (typeof ReadableStream !== "undefined" ? ReadableStream.prototype : null) as AsyncIterableStream | null;
if (proto && !proto[Symbol.asyncIterator]) {
  const values = async function* (this: ReadableStream, opts?: { preventCancel?: boolean }) {
    const reader = this.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        yield value;
      }
    } finally {
      if (!opts?.preventCancel) void reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  };
  Object.defineProperty(proto, "values", { value: values, configurable: true, writable: true });
  Object.defineProperty(proto, Symbol.asyncIterator, { value: values, configurable: true, writable: true });
}

export {};
