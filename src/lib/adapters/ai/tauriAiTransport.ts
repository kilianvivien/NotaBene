/**
 * AI traffic routed through Rust.
 *
 * The webview's `connect-src` is an allowlist, and bring-your-own-key means the
 * user may point NotaBene at a host we have never heard of. Rather than open
 * the policy with a wildcard — which would loosen it for every script in the
 * page, not just for AI — the desktop build hands the request to
 * `src-tauri/src/ai.rs` and lets it make the call. The provider code above this
 * adapter cannot tell the difference.
 */
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { AiRequest, AiResponse, AiTransport } from './AiTransport';
import { SseBuffer } from './sse';

const STREAM_EVENT = 'notabene-ai-stream';

interface StreamFrame {
  streamId: string;
  kind: 'chunk' | 'done' | 'error';
  data?: string;
}

/** The Rust command takes the request without the `AbortSignal`, which has no
 * representation on the wire — cancellation travels as its own command. */
function wire(request: AiRequest) {
  return {
    url: request.url,
    method: request.method,
    headers: request.headers,
    body: request.body ?? null,
  };
}

export const tauriAiTransport: AiTransport = {
  async request(request: AiRequest): Promise<AiResponse> {
    // A whole-response call is the one every structured feature makes, and on a
    // local model it is also the one that takes minutes. Without an id to name
    // it by there is nothing for Cancel to reach: the promise would resolve
    // when the model finished either way, and the GPU would run to the end.
    const requestId = crypto.randomUUID();
    const onAbort = () => {
      void invoke('ai_cancel', { id: requestId });
    };
    request.signal?.addEventListener('abort', onAbort, { once: true });

    try {
      return await invoke<AiResponse>('ai_request', {
        requestId,
        request: wire(request),
      });
    } finally {
      request.signal?.removeEventListener('abort', onAbort);
    }
  },

  async *stream(request: AiRequest): AsyncIterable<string> {
    const streamId = crypto.randomUUID();
    const frames = new SseBuffer();

    // Chunks arrive as events, which do not wait for anyone; the generator is
    // pulled at the consumer's pace. The queue is what stands between the two
    // so a fast model cannot drop tokens on a slow render.
    const queue: string[] = [];
    let finished: 'done' | 'error' | null = null;
    let failure: string | null = null;
    let wake: (() => void) | null = null;

    const nudge = () => {
      wake?.();
      wake = null;
    };

    const unlisten = await listen<StreamFrame>(STREAM_EVENT, (event) => {
      const frame = event.payload;
      if (frame.streamId !== streamId) return;
      if (frame.kind === 'chunk') {
        queue.push(...frames.push(frame.data ?? ''));
      } else if (frame.kind === 'error') {
        failure = frame.data ?? 'ai stream failed';
        finished = 'error';
      } else {
        queue.push(...frames.flush());
        finished = 'done';
      }
      nudge();
    });

    const onAbort = () => {
      void invoke('ai_cancel', { id: streamId });
    };
    request.signal?.addEventListener('abort', onAbort, { once: true });

    // Not awaited: `ai_stream` resolves when the stream ends, and we need to be
    // yielding long before that. Its rejection is surfaced through the same
    // error frame path so there is one place to handle failure.
    const call = invoke('ai_stream', { streamId, request: wire(request) }).catch(
      (error: unknown) => {
        failure = String(error);
        finished = 'error';
        nudge();
      },
    );

    try {
      for (;;) {
        while (queue.length) yield queue.shift()!;
        if (finished === 'error') throw new Error(failure ?? 'ai stream failed');
        if (finished === 'done') return;
        if (request.signal?.aborted) throw new DOMException('aborted', 'AbortError');
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    } finally {
      request.signal?.removeEventListener('abort', onAbort);
      // A consumer that stops early — the user closed the panel — must not
      // leave the model billing away on the other side of the bridge.
      if (!finished) void invoke('ai_cancel', { id: streamId });
      unlisten();
      void call;
    }
  },
};
