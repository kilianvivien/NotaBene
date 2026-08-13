import { describe, expect, it } from 'vitest';
import { installStreamAsyncIterator } from './streamAsyncIterator';

/** A `ReadableStream` as WebKit hands it over: readable, but not iterable. */
class WebKitStream {
  private chunks: string[];

  constructor(chunks: string[]) {
    this.chunks = [...chunks];
  }

  getReader() {
    let cancelled = false;
    const chunks = this.chunks;
    return {
      cancels: 0,
      async read() {
        if (cancelled || chunks.length === 0) return { done: true, value: undefined };
        return { done: false, value: chunks.shift() };
      },
      async cancel() {
        cancelled = true;
      },
      releaseLock() {},
    };
  }
}

describe('installStreamAsyncIterator', () => {
  it('makes an unadorned stream iterable, the way pdfjs reads text content', async () => {
    expect(installStreamAsyncIterator(WebKitStream)).toBe(true);
    const seen: unknown[] = [];
    const stream = new WebKitStream(['a', 'b', 'c']) as unknown as AsyncIterable<string>;
    for await (const chunk of stream) {
      seen.push(chunk);
    }
    expect(seen).toEqual(['a', 'b', 'c']);
  });

  it('leaves a platform that already iterates streams alone', () => {
    expect(installStreamAsyncIterator(WebKitStream)).toBe(false);
    expect(installStreamAsyncIterator(ReadableStream)).toBe(false);
  });

  it('ignores a missing implementation rather than throwing', () => {
    expect(installStreamAsyncIterator(undefined)).toBe(false);
    expect(installStreamAsyncIterator({ prototype: {} })).toBe(false);
  });
});
