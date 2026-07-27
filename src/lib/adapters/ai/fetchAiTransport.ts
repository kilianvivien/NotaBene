/** `fetch`-based AI transport. Used by the browser build, where the page's own
 * connect-src is the only policy there is. The desktop build uses the Rust
 * transport instead, so a user-supplied base URL is not also a CSP edit. */
import type { AiRequest, AiResponse, AiTransport } from './AiTransport';
import { SseBuffer } from './sse';

export const fetchAiTransport: AiTransport = {
  async request(request: AiRequest): Promise<AiResponse> {
    const response = await fetch(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      signal: request.signal,
    });
    return {
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      body: await response.text(),
    };
  },

  async *stream(request: AiRequest): AsyncIterable<string> {
    const response = await fetch(request.url, {
      method: request.method,
      headers: { ...request.headers, Accept: 'text/event-stream' },
      body: request.body,
      signal: request.signal,
    });
    if (!response.ok || !response.body) {
      // The body of a failed streaming call is an ordinary error document, and
      // it is the only place the provider says *why*.
      const detail = response.body ? await response.text() : '';
      throw new Error(`${response.status} ${detail}`.trim());
    }

    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    const frames = new SseBuffer();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        yield* frames.push(value);
      }
      yield* frames.flush();
    } finally {
      reader.releaseLock();
    }
  },
};
