import { openInput } from '../recorder/mediaRecorderAdapter';
import type {
  DictationAdapter,
  DictationRequest,
  DictationSession,
} from './DictationAdapter';

export interface DictationConnection {
  send(pcm: Uint8Array): Promise<void>;
  finish(): Promise<void>;
  cancel(): Promise<void>;
}

export interface DictationTransport {
  connect(request: DictationRequest, sampleRate: number): Promise<DictationConnection>;
}

/** The provider expects signed little-endian PCM, regardless of host endianness. */
export function pcm16(samples: Float32Array): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  samples.forEach((value, index) => {
    const sample = Number.isFinite(value) ? Math.max(-1, Math.min(1, value)) : 0;
    view.setInt16(index * 2, Math.round(sample * (sample < 0 ? 32768 : 32767)), true);
  });
  return bytes;
}

export function createMediaDictationAdapter(
  transport: DictationTransport,
): DictationAdapter {
  return {
    supported: () =>
      typeof navigator.mediaDevices?.getUserMedia === 'function' &&
      typeof AudioContext !== 'undefined' &&
      typeof AudioWorkletNode !== 'undefined',

    async start(request): Promise<DictationSession> {
      if (request.signal.aborted) throw new DOMException('cancelled', 'AbortError');
      const opened = await openInput(request.input);
      let context: AudioContext | null = null;
      let node: AudioWorkletNode | null = null;
      let connection: DictationConnection | null = null;
      let stopMeter = () => {};
      let released = false;
      let stopping = false;
      let failed = false;
      let queue = Promise.resolve();
      let queued = 0;
      let flushed: (() => void) | null = null;

      const release = () => {
        if (released) return;
        released = true;
        opened.close();
        stopMeter();
        node?.disconnect();
        if (context) void context.close().catch(() => {});
      };
      const fail = (error: unknown) => {
        if (failed || request.signal.aborted) return;
        failed = true;
        release();
        void connection?.cancel().catch(() => {});
        request.onFailure(error);
      };
      const abort = () => {
        release();
        void connection?.cancel().catch(() => {});
      };
      request.signal.addEventListener('abort', abort, { once: true });

      try {
        if (request.signal.aborted) throw new DOMException('cancelled', 'AbortError');
        context = new AudioContext({ sampleRate: 16_000 });
        await context.resume();
        await context.audioWorklet.addModule(
          new URL(`${import.meta.env.BASE_URL}dictation-processor.js`, document.baseURI)
            .href,
        );
        if (request.signal.aborted) throw new DOMException('cancelled', 'AbortError');
        connection = await transport.connect(
          { ...request, onFailure: fail },
          context.sampleRate,
        );
        if (request.signal.aborted) throw new DOMException('cancelled', 'AbortError');
        node = new AudioWorkletNode(context, 'notabene-dictation');
        node.port.onmessage = (event: MessageEvent<unknown>) => {
          if (event.data === 'flushed') {
            flushed?.();
            return;
          }
          if (!(event.data instanceof Float32Array) || failed || request.signal.aborted)
            return;
          if (++queued > 32) {
            fail(new Error('DICTATION_BACKPRESSURE'));
            return;
          }
          const bytes = pcm16(event.data);
          queue = queue
            .then(async () => {
              if (!failed && !request.signal.aborted) await connection!.send(bytes);
            })
            .catch(fail)
            .finally(() => {
              queued -= 1;
            });
        };
        context.createMediaStreamSource(opened.stream).connect(node);
        node.connect(context.destination); // The processor's output is silent.
        stopMeter = opened.meter(request.onLevel);
        opened.microphone.getAudioTracks()[0]?.addEventListener('ended', () => {
          if (!stopping) fail(new Error('DICTATION_MICROPHONE'));
        });
      } catch (error) {
        release();
        request.signal.removeEventListener('abort', abort);
        await connection?.cancel().catch(() => {});
        throw error;
      }

      let stopPromise: Promise<void> | null = null;
      return {
        stop() {
          if (stopPromise) return stopPromise;
          stopping = true;
          stopPromise = (async () => {
            // Stop listening now; the worklet still has its last partial frame.
            opened.close();
            stopMeter();
            try {
              if (failed || request.signal.aborted) return;
              await new Promise<void>((resolve, reject) => {
                const timer = setTimeout(
                  () => reject(new Error('DICTATION_FLUSH')),
                  1500,
                );
                flushed = () => {
                  clearTimeout(timer);
                  resolve();
                };
                node!.port.postMessage('flush');
              });
              await queue;
              if (failed) throw new Error('DICTATION_CONNECTION');
              await connection!.finish();
            } finally {
              release();
              request.signal.removeEventListener('abort', abort);
              await connection!.cancel().catch(() => {});
            }
          })();
          return stopPromise;
        },
        async cancel() {
          stopping = true;
          release();
          request.signal.removeEventListener('abort', abort);
          await connection!.cancel();
        },
      };
    },
  };
}
