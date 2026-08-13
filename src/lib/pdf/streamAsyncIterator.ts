/**
 * `for await (… of readableStream)` for WebKit.
 *
 * Async iteration over a `ReadableStream` is specified and shipped everywhere
 * except WebKit, and `pdfjs` reads a page's text with
 * `for await (const value of readableStream)`. In the desktop webview that
 * throws `TypeError: undefined is not a function` before a single glyph is
 * measured, which takes the whole page render down with it — the text layer,
 * the search index, and every highlight built on top of them.
 *
 * The shim follows the stream spec's `values()`: a reader held for the length
 * of the loop, released when it ends, and the stream cancelled on early exit
 * unless the caller asked to keep it.
 */
interface StreamPrototype {
  getReader(): {
    read(): Promise<{ done: boolean; value: unknown }>;
    cancel(reason?: unknown): Promise<void>;
    releaseLock(): void;
  };
}

export function installStreamAsyncIterator(
  target: { prototype: unknown } | undefined = globalThis.ReadableStream,
): boolean {
  const prototype = target?.prototype as
    (StreamPrototype & Record<symbol | string, unknown>) | undefined;
  if (!prototype || typeof prototype.getReader !== 'function') return false;
  if (prototype[Symbol.asyncIterator]) return false;

  function values(this: StreamPrototype, { preventCancel = false } = {}) {
    const reader = this.getReader();
    return {
      async next() {
        try {
          const result = await reader.read();
          if (result.done) reader.releaseLock();
          return result;
        } catch (error) {
          reader.releaseLock();
          throw error;
        }
      },
      async return(value?: unknown) {
        if (preventCancel) {
          reader.releaseLock();
        } else {
          const cancelled = reader.cancel(value);
          reader.releaseLock();
          await cancelled;
        }
        return { done: true, value };
      },
      [Symbol.asyncIterator]() {
        return this;
      },
    };
  }

  prototype.values ??= values;
  prototype[Symbol.asyncIterator] = values;
  return true;
}
