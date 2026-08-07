/// <reference lib="webworker" />

import { concatWav } from './wav';

self.addEventListener(
  'message',
  (event: MessageEvent<{ files: ArrayBuffer[]; gapMs: number }>) => {
    try {
      const bytes = concatWav(
        event.data.files.map((file) => new Uint8Array(file)),
        event.data.gapMs,
      );
      self.postMessage({ ok: true, bytes: bytes.buffer }, [bytes.buffer]);
    } catch (cause) {
      self.postMessage({
        ok: false,
        error: cause instanceof Error ? cause.message : String(cause),
      });
    }
  },
);

export {};
