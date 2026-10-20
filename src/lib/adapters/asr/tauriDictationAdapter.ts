import { Channel, invoke } from '@tauri-apps/api/core';
import { DictationEventSchema } from '@/lib/schema/dictation';
import {
  createMediaDictationAdapter,
  type DictationTransport,
} from './mediaDictationAdapter';

export const tauriDictationTransport: DictationTransport = {
  async connect(request, sampleRate) {
    const id = crypto.randomUUID();
    let ready = false;
    let complete = false;
    let closing = false;
    let failed = false;
    let text = '';
    let resolveReady!: () => void;
    let rejectReady!: (error: unknown) => void;
    let resolveDone!: () => void;
    let rejectDone!: (error: unknown) => void;
    const connected = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    const done = new Promise<void>((resolve, reject) => {
      resolveDone = resolve;
      rejectDone = reject;
    });
    // A provider may fail before Stop starts awaiting the final transcript.
    void done.catch(() => {});
    const cancel = async () => {
      await invoke('dictation_cancel', { id });
    };
    const fail = (error: unknown) => {
      if (complete || failed || closing) return;
      failed = true;
      rejectReady(error);
      rejectDone(error);
      request.onFailure(error);
      void cancel().catch(() => {});
    };
    const output = new Channel<unknown>();
    output.onmessage = (payload) => {
      if (closing || failed) return;
      if (request.signal.aborted) {
        fail(new DOMException('cancelled', 'AbortError'));
        return;
      }
      const parsed = DictationEventSchema.safeParse(payload);
      if (!parsed.success) {
        fail(new Error('DICTATION_RESPONSE'));
        return;
      }
      try {
        const event = parsed.data;
        if (event.type === 'ready') {
          ready = true;
          resolveReady();
        } else if (event.type === 'transcription.text.delta') {
          text += event.text;
          request.onText(event.text);
        } else {
          if (!event.text.startsWith(text)) throw new Error('DICTATION_TRANSCRIPT');
          const tail = event.text.slice(text.length);
          if (tail) request.onText(tail);
          complete = true;
          resolveDone();
        }
      } catch (error) {
        fail(error);
      }
    };
    const abort = () => {
      fail(new DOMException('cancelled', 'AbortError'));
      void cancel().catch(() => {});
    };
    request.signal.addEventListener('abort', abort, { once: true });
    const running = invoke('dictation_run', {
      id,
      apiKey: request.apiKey,
      sampleRate,
      vocabulary: request.vocabulary,
      output,
    })
      .then(() => {
        if (!complete && !closing) fail(new Error('DICTATION_CONNECTION'));
      })
      .catch(fail)
      .finally(() => request.signal.removeEventListener('abort', abort));
    if (request.signal.aborted) abort();
    try {
      await connected;
    } catch (error) {
      closing = true;
      await cancel().catch(() => {});
      throw error;
    }
    return {
      async send(pcm) {
        if (!ready || failed || closing) throw new Error('DICTATION_CLOSED');
        let binary = '';
        for (const byte of pcm) binary += String.fromCharCode(byte);
        await invoke('dictation_audio', { id, data: btoa(binary) });
      },
      async finish() {
        await invoke('dictation_audio', { id, data: null });
        await done;
        await running;
      },
      async cancel() {
        closing = true;
        await cancel();
        await running;
      },
    };
  },
};

export const tauriDictationAdapter = createMediaDictationAdapter(tauriDictationTransport);
