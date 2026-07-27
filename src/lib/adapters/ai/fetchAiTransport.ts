/** `fetch`-based AI transport. Used by the browser build, and by the desktop
 * build for providers already allowed by the CSP connect-src list. */
import type { AiRequest, AiResponse, AiTransport } from './AiTransport';

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
      throw new Error(`stream failed with status ${response.status}`);
    }

    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += value;
        // SSE events are separated by a blank line; anything short of that is
        // a partial frame we must hold onto.
        let boundary = buffer.indexOf('\n\n');
        while (boundary !== -1) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          for (const line of frame.split('\n')) {
            if (line.startsWith('data:')) yield line.slice(5).trim();
          }
          boundary = buffer.indexOf('\n\n');
        }
      }
    } finally {
      reader.releaseLock();
    }
  },
};
